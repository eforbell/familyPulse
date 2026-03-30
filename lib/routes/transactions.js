'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Router } = require('express');
const multer = require('multer');
const { requireParent } = require('../auth');
const { pool, withTransaction } = require('../db');
const { previewDuplicateImports, applyDuplicateHide } = require('../transaction-dedup');
const logger = require('../logger');
const {
  getRawSourceText,
  computeEffectiveDisplayName,
  isCheckLikeRawSourceText,
  upsertMerchantRenameRule
} = require('../merchant-rename-rules');
const {
  buildStoredFilename,
  buildAttachmentPath,
  ensureTransactionFilesDir,
  safeDeleteAttachmentFile
} = require('../transaction-attachments');

const router = Router();
const MAX_TRANSACTION_NOTE_LENGTH = 4000;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MIN_MERCHANT_SUGGESTION_QUERY_LENGTH = 2;
const MAX_MERCHANT_SUGGESTIONS = 6;
const MAX_ATTACHMENT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_REQUEST = 10;
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_FILE_SIZE,
    files: MAX_ATTACHMENTS_PER_REQUEST
  }
});
const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['application/pdf', ['.pdf']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/heic', ['.heic']],
  ['image/heif', ['.heif', '.heic']]
]);

function buildContentDispositionFilename(originalFilename) {
  const basename = path.basename(originalFilename || 'attachment');
  const asciiSafe = basename.replace(/["\\\r\n]/g, '_');
  const encoded = encodeURIComponent(basename);
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

function serializeNote(transaction) {
  if (!transaction.note) return null;
  return {
    text: transaction.note,
    updated_at: transaction.note_updated_at,
    updated_by_name: transaction.note_updated_by_name || null
  };
}

function serializeAttachment(row) {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    created_at: row.created_at,
    uploaded_by_name: row.uploaded_by_name || null
  };
}

function serializeRenameRule(transaction) {
  if (!transaction.rename_rule_id) return null;
  return {
    id: transaction.rename_rule_id,
    raw_source_text: transaction.rename_rule_raw_source_text,
    display_name: transaction.rename_rule_display_name,
    updated_at: transaction.rename_rule_updated_at || null,
    enabled: true,
    match_type: 'exact'
  };
}

function serializeTransactionDetail(transaction, attachments) {
  const rawDisplayName = getRawSourceText(transaction) || null;
  return {
    ...transaction,
    effective_display_name: computeEffectiveDisplayName(transaction) || null,
    raw_display_name: rawDisplayName,
    raw_display_name_is_check_like: isCheckLikeRawSourceText(rawDisplayName),
    rename_rule: serializeRenameRule(transaction),
    note: serializeNote(transaction),
    attachments
  };
}

async function getAttachmentsForTransaction(transactionId) {
  const { rows } = await pool.query(
    `SELECT ta.id, ta.transaction_id, ta.original_filename, ta.mime_type, ta.byte_size, ta.created_at,
            fm.name AS uploaded_by_name
     FROM transaction_attachments ta
     LEFT JOIN family_members fm ON fm.id = ta.uploaded_by
     WHERE ta.transaction_id = $1
     ORDER BY ta.created_at DESC, ta.id DESC`,
    [transactionId]
  );
  return rows.map(serializeAttachment);
}

async function getVisibleTransactionById(id, member) {
  const params = [id];
  let scopeClause = '';

  if (member && member.role === 'kid') {
    params.push(member.id);
    scopeClause = 'AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = t.account_id AND am.member_id = $2)';
  }

  const { rows } = await pool.query(
    `SELECT t.id, t.plaid_transaction_id, t.account_id, t.amount, t.date, t.authorized_date,
            t.merchant_name, t.name, t.pending, t.is_transfer, t.transfer_type,
            t.category_id, t.source, t.is_hidden, t.hidden_reason, t.duplicate_of_transaction_id,
            t.source_removed, t.source_removed_at, t.created_at, t.updated_at,
            t.display_name_override, t.display_name_override_updated_at,
            COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask,
            a.type AS account_type, a.sync_status AS account_sync_status,
            c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            tn.note, tn.updated_at AS note_updated_at, fm.name AS note_updated_by_name,
            fm_override.name AS display_name_override_updated_by_name,
            mrr.id AS rename_rule_id, mrr.raw_source_text AS rename_rule_raw_source_text,
            mrr.display_name AS rename_rule_display_name, mrr.updated_at AS rename_rule_updated_at
     FROM transactions t
     JOIN accounts a ON t.account_id = a.id
     LEFT JOIN categories c ON t.category_id = c.id
     LEFT JOIN transaction_notes tn ON tn.transaction_id = t.id
     LEFT JOIN family_members fm ON fm.id = tn.updated_by
     LEFT JOIN family_members fm_override ON fm_override.id = t.display_name_override_updated_by
     LEFT JOIN merchant_rename_rules mrr
       ON mrr.enabled = true
      AND mrr.match_type = 'exact'
      AND mrr.raw_source_text = COALESCE(t.merchant_name, t.name)
     WHERE t.id = $1
     ${scopeClause}`,
    params
  );

  return rows[0] || null;
}

async function getVisibleAttachmentById(id, member) {
  const params = [id];
  let scopeClause = '';

  if (member && member.role === 'kid') {
    params.push(member.id);
    scopeClause = 'AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = t.account_id AND am.member_id = $2)';
  }

  const { rows } = await pool.query(
    `SELECT ta.id, ta.transaction_id, ta.original_filename, ta.stored_filename, ta.mime_type, ta.byte_size, ta.created_at,
            fm.name AS uploaded_by_name
     FROM transaction_attachments ta
     JOIN transactions t ON t.id = ta.transaction_id
     LEFT JOIN family_members fm ON fm.id = ta.uploaded_by
     WHERE ta.id = $1
     ${scopeClause}`,
    params
  );

  return rows[0] || null;
}

function validateAttachmentFile(file) {
  const mimeType = String(file?.mimetype || '').toLowerCase();
  const ext = path.extname(file?.originalname || '').toLowerCase();
  const allowedExtensions = ALLOWED_ATTACHMENT_TYPES.get(mimeType);

  if (!allowedExtensions) {
    throw Object.assign(new Error('Unsupported attachment type'), { status: 400 });
  }

  if (!allowedExtensions.includes(ext)) {
    throw Object.assign(new Error('Attachment extension does not match content type'), { status: 400 });
  }
}

function parseAttachmentUpload(req, res) {
  return new Promise((resolve, reject) => {
    attachmentUpload.array('files', MAX_ATTACHMENTS_PER_REQUEST)(req, res, (err) => {
      if (!err) return resolve(req.files || []);

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return reject(Object.assign(new Error(`Attachment exceeds ${MAX_ATTACHMENT_FILE_SIZE} byte limit`), { status: 400 }));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return reject(Object.assign(new Error(`Maximum ${MAX_ATTACHMENTS_PER_REQUEST} attachments per upload`), { status: 400 }));
        }
      }

      return reject(err);
    });
  });
}

// ── GET /api/transactions ────────────────────────────────────

router.get('/api/transactions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const accountId = req.query.account_id ? parseInt(req.query.account_id) : null;
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;
    const categoryId = req.query.category_id;
    const search = req.query.search || null;
    const showTransfers = req.query.show_transfers === '1';
    const showHidden = req.query.show_hidden === '1';
    const dedupRunId = req.query.dedup_run_id ? parseInt(req.query.dedup_run_id, 10) : null;
    const allowedSortFields = new Set(['date', 'amount']);
    const allowedSortDirections = new Set(['asc', 'desc']);
    const sortField = allowedSortFields.has(req.query.sort_field) ? req.query.sort_field : 'date';
    const sortDirection = allowedSortDirections.has(req.query.sort_direction) ? req.query.sort_direction : 'desc';

    // Build WHERE clause dynamically
    const conditions = [];
    const params = [];
    let idx = 1;

    if (!showTransfers) {
      conditions.push('t.is_transfer = false');
    }
    if (!showHidden) {
      conditions.push('t.is_hidden = false');
    }

    if (accountId) {
      conditions.push(`t.account_id = $${idx++}`);
      params.push(accountId);
    }

    if (dateFrom) {
      conditions.push(`t.date >= $${idx++}`);
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push(`t.date <= $${idx++}`);
      params.push(dateTo);
    }

    if (categoryId !== undefined && categoryId !== '') {
      if (categoryId === '0') {
        conditions.push(`(
          t.category_id IS NULL
          OR t.category_id = (SELECT id FROM categories WHERE name = 'Uncategorized')
        )`);
      } else {
        conditions.push(`t.category_id = $${idx++}`);
        params.push(parseInt(categoryId));
      }
    }

    if (search) {
      conditions.push(`(
        COALESCE(t.display_name_override, t.merchant_name, t.name) ILIKE $${idx}
        OR t.merchant_name ILIKE $${idx}
        OR t.name ILIKE $${idx}
      )`);
      params.push(`%${search}%`);
      idx++;
    }

    if (dedupRunId) {
      conditions.push(`t.dedup_run_id = $${idx++}`);
      params.push(dedupRunId);
    }

    // Kid scoping: restrict to linked accounts via account_members
    const member = req.member;
    if (member && member.role === 'kid') {
      conditions.push(`a.id IN (SELECT account_id FROM account_members WHERE member_id = $${idx++})`);
      params.push(member.id);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Get total count and sum with filters
    const countQuery = `
      SELECT count(*)::int AS total, COALESCE(sum(t.amount), 0)::numeric AS sum
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      ${whereClause}
    `;
    const { rows: [stats] } = await pool.query(countQuery, params);

    // Get paginated transactions
    const dataQuery = `
      SELECT t.id, t.plaid_transaction_id, t.amount, t.date, t.authorized_date,
             t.merchant_name, t.name, t.pending, t.is_transfer, t.transfer_type,
             t.category_id, t.source, t.is_hidden, t.hidden_reason, t.duplicate_of_transaction_id,
             t.display_name_override,
             COALESCE(t.display_name_override, t.merchant_name, t.name) AS effective_display_name,
             COALESCE(t.merchant_name, t.name) AS raw_display_name,
             COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask,
             a.type AS account_type, a.sync_status AS account_sync_status,
             c.name AS category_name, c.color AS category_color, c.icon AS category_icon
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      ${whereClause}
      ORDER BY ${sortField === 'amount' ? 'ABS(t.amount)' : 't.date'} ${sortDirection.toUpperCase()}, t.date DESC, t.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);

    res.json({
      transactions: rows,
      total: stats.total,
      sum: parseFloat(stats.sum),
      limit,
      offset,
      sort_field: sortField,
      sort_direction: sortDirection
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/transactions/merchant-suggestions ───────────────

router.get('/api/transactions/merchant-suggestions', requireParent, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < MIN_MERCHANT_SUGGESTION_QUERY_LENGTH) {
      return res.json({ suggestions: [] });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || MAX_MERCHANT_SUGGESTIONS, 1), MAX_MERCHANT_SUGGESTIONS);
    // This is intentionally a simple history scan in v1. For the expected household-scale
    // dataset it keeps the feature schema-free; if transaction volume grows substantially,
    // a materialized merchant directory can replace this query behind the same API contract.
    const { rows } = await pool.query(
      `SELECT effective_display_name AS label,
              COUNT(*)::int AS usage_count,
              MAX(date) AS last_seen_date
       FROM (
         SELECT COALESCE(display_name_override, merchant_name, name) AS effective_display_name, date
         FROM transactions
         WHERE COALESCE(display_name_override, merchant_name, name) IS NOT NULL
       ) ranked_names
       WHERE effective_display_name ILIKE $1
       GROUP BY effective_display_name
       ORDER BY COUNT(*) DESC, MAX(date) DESC, effective_display_name ASC
       LIMIT $2`,
      [`${query}%`, limit]
    );

    res.json({
      suggestions: rows.map(row => ({
        label: row.label,
        usage_count: row.usage_count,
        last_seen_date: row.last_seen_date
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/transactions/:id — detail payload ──────────────

router.get('/api/transactions/:id(\\d+)', async (req, res) => {
  try {
    const transaction = await getVisibleTransactionById(parseInt(req.params.id, 10), req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({
      transaction: serializeTransactionDetail(transaction, await getAttachmentsForTransaction(transaction.id))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/transactions/:id/attachments ───────────────────

router.get('/api/transactions/:id(\\d+)/attachments', async (req, res) => {
  try {
    const transaction = await getVisibleTransactionById(parseInt(req.params.id, 10), req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const attachments = await getAttachmentsForTransaction(transaction.id);
    res.json({ attachments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/:id/attachments ──────────────────

router.post('/api/transactions/:id(\\d+)/attachments', requireParent, async (req, res) => {
  const stagedFiles = [];
  try {
    const id = parseInt(req.params.id, 10);
    const transaction = await getVisibleTransactionById(id, req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const files = await parseAttachmentUpload(req, res);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    await ensureTransactionFilesDir();
    for (const file of files) {
      validateAttachmentFile(file);
    }

    const stagedMetadata = [];
    for (const file of files) {
      const storedFilename = buildStoredFilename(file.originalname);
      const filePath = buildAttachmentPath(storedFilename);
      await fsp.writeFile(filePath, file.buffer, { flag: 'wx', mode: 0o640 });
      stagedFiles.push(storedFilename);
      stagedMetadata.push({
        original_filename: file.originalname,
        stored_filename: storedFilename,
        mime_type: file.mimetype,
        byte_size: file.size
      });
    }

    const attachments = await withTransaction(async (client) => {
      const inserted = [];
      for (const file of stagedMetadata) {
        const { rows: [attachment] } = await client.query(
          `INSERT INTO transaction_attachments (
             transaction_id, original_filename, stored_filename, mime_type, byte_size, uploaded_by
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, transaction_id, original_filename, mime_type, byte_size, created_at`,
          [id, file.original_filename, file.stored_filename, file.mime_type, file.byte_size, req.member.id]
        );

        inserted.push(attachment);
        logger.info('Transaction attachment stored', {
          transactionId: id,
          attachmentId: attachment.id,
          mimeType: file.mime_type,
          byteSize: file.byte_size
        });
      }
      return inserted;
    });

    const fullAttachments = await getAttachmentsForTransaction(id);
    const createdIds = new Set(attachments.map(row => row.id));
    res.status(201).json({
      success: true,
      attachments: fullAttachments.filter(row => createdIds.has(row.id))
    });
  } catch (err) {
    for (const storedFilename of stagedFiles) {
      try {
        await safeDeleteAttachmentFile(storedFilename);
      } catch (cleanupErr) {
        logger.warn('Attachment cleanup failed after upload error', { error: cleanupErr.message });
      }
    }
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/transactions/dedup/preview ────────────────────

router.post('/api/transactions/dedup/preview', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const dateFrom = req.body?.date_from || null;
    const dateTo = req.body?.date_to || null;
    const preview = await previewDuplicateImports({ dateFrom, dateTo });
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/dedup/apply ──────────────────────

router.post('/api/transactions/dedup/apply', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const dateFrom = req.body?.date_from || null;
    const dateTo = req.body?.date_to || null;
    const actor = req.member?.name || 'system';
    const result = await applyDuplicateHide({ dateFrom, dateTo, actor });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/transactions/dedup/runs ────────────────────────

router.get('/api/transactions/dedup/runs', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      `SELECT id, strategy, txns_hidden, category_copied, ambiguous_count, created_by, created_at
       FROM dedup_runs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/hide ──────────────────────────

router.put('/api/transactions/:id/hide', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }

    const { id } = req.params;
    const { rows: [tx] } = await pool.query(
      `SELECT id, source, is_hidden FROM transactions WHERE id = $1`,
      [id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.source === 'plaid') {
      return res.status(400).json({ error: 'Plaid transactions cannot be manually suppressed' });
    }
    if (tx.is_hidden) return res.json({ success: true, id: tx.id, already_hidden: true });

    await pool.query(
      `UPDATE transactions
       SET is_hidden = true,
           hidden_reason = COALESCE($1, 'manual_duplicate_suppress'),
           duplicate_of_transaction_id = COALESCE($2, duplicate_of_transaction_id),
           updated_at = now()
       WHERE id = $3`,
      [req.body?.reason || null, req.body?.duplicate_of_transaction_id || null, id]
    );

    res.json({ success: true, id: tx.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/unhide ────────────────────────

router.put('/api/transactions/:id/unhide', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }

    const { id } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE transactions
       SET is_hidden = false,
           hidden_reason = NULL,
           duplicate_of_transaction_id = NULL,
           dedup_run_id = NULL,
           updated_at = now()
       WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true, id: parseInt(id, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/category ───────────────────────

router.put('/api/transactions/:id/category', async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id } = req.body;
    const member = req.member;

    // Kid scoping: verify transaction belongs to kid's linked account
    if (member && member.role === 'kid') {
      const { rows: check } = await pool.query(
        `SELECT t.id FROM transactions t
         JOIN account_members am ON am.account_id = t.account_id AND am.member_id = $1
         WHERE t.id = $2`,
        [member.id, id]
      );
      if (check.length === 0) {
        return res.status(403).json({ error: 'Parent access required' });
      }
    }

    const { rows } = await pool.query(
      'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = $2 RETURNING id',
      [category_id, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/note ──────────────────────────

router.put('/api/transactions/:id(\\d+)/note', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const incoming = typeof req.body?.note === 'string' ? req.body.note.trim() : '';

    const transaction = await getVisibleTransactionById(id, req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (!incoming) {
      await pool.query('DELETE FROM transaction_notes WHERE transaction_id = $1', [id]);
      const refreshed = await getVisibleTransactionById(id, req.member);
      return res.json({ success: true, transaction: serializeTransactionDetail(refreshed, await getAttachmentsForTransaction(id)) });
    }

    if (incoming.length > MAX_TRANSACTION_NOTE_LENGTH) {
      return res.status(400).json({ error: `Note must be ${MAX_TRANSACTION_NOTE_LENGTH} characters or fewer` });
    }

    await pool.query(
      `INSERT INTO transaction_notes (transaction_id, note, created_by, updated_by)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (transaction_id) DO UPDATE SET
         note = EXCLUDED.note,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [id, incoming, req.member.id]
    );

    const refreshed = await getVisibleTransactionById(id, req.member);
    res.json({
      success: true,
      transaction: serializeTransactionDetail(refreshed, await getAttachmentsForTransaction(id))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/transactions/:id/note ───────────────────────

router.delete('/api/transactions/:id(\\d+)/note', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const transaction = await getVisibleTransactionById(id, req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    await pool.query('DELETE FROM transaction_notes WHERE transaction_id = $1', [id]);
    const refreshed = await getVisibleTransactionById(id, req.member);
    res.json({
      success: true,
      transaction: serializeTransactionDetail(refreshed, await getAttachmentsForTransaction(id))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/display-name ──────────────────

router.put('/api/transactions/:id(\\d+)/display-name', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const incoming = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';

    const transaction = await getVisibleTransactionById(id, req.member);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (incoming.length > MAX_DISPLAY_NAME_LENGTH) {
      return res.status(400).json({ error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer` });
    }

    const applyToFuture = req.body?.apply_to_future === true || req.body?.apply_to_future === 'true';

    await withTransaction(async (client) => {
      if (!incoming) {
        await client.query(
          `UPDATE transactions
           SET display_name_override = NULL,
               display_name_override_updated_by = NULL,
               display_name_override_updated_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [id]
        );
        return;
      }

      await client.query(
        `UPDATE transactions
         SET display_name_override = $1,
             display_name_override_updated_by = $2,
             display_name_override_updated_at = now(),
             updated_at = now()
         WHERE id = $3`,
        [incoming, req.member.id, id]
      );

      if (applyToFuture) {
        await upsertMerchantRenameRule(client, {
          rawSourceText: getRawSourceText(transaction),
          displayName: incoming,
          createdBy: req.member.id
        });
      }
    });

    const refreshed = await getVisibleTransactionById(id, req.member);
    res.json({
      success: true,
      transaction: serializeTransactionDetail(refreshed, await getAttachmentsForTransaction(id))
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/transaction-attachments/:id/download ───────────

router.get('/api/transaction-attachments/:id(\\d+)/download', async (req, res) => {
  try {
    const attachment = await getVisibleAttachmentById(parseInt(req.params.id, 10), req.member);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const filePath = buildAttachmentPath(attachment.stored_filename);
    try {
      await fsp.access(filePath, fs.constants.R_OK);
    } catch {
      return res.status(404).json({ error: 'Attachment file missing' });
    }

    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Length', attachment.byte_size);
    res.setHeader('Content-Disposition', buildContentDispositionFilename(attachment.original_filename));
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/merchant-rename-rules ───────────────────────────

router.get('/api/merchant-rename-rules', requireParent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mrr.id, mrr.raw_source_text, mrr.display_name, mrr.match_type, mrr.enabled,
              mrr.created_at, mrr.updated_at, mrr.last_matched_at, fm.name AS created_by_name
       FROM merchant_rename_rules mrr
       LEFT JOIN family_members fm ON fm.id = mrr.created_by
       ORDER BY mrr.updated_at DESC, mrr.id DESC`
    );
    res.json({ rules: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/merchant-rename-rules/:id ───────────────────────

router.put('/api/merchant-rename-rules/:id(\\d+)', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled boolean is required' });
    }

    const { rows } = await pool.query(
      `UPDATE merchant_rename_rules
       SET enabled = $1,
           updated_at = now()
       WHERE id = $2
       RETURNING id, raw_source_text, display_name, match_type, enabled, created_at, updated_at, last_matched_at`,
      [req.body.enabled, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Rename rule not found' });
    }

    res.json({ success: true, rule: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/merchant-rename-rules/:id ────────────────────

router.delete('/api/merchant-rename-rules/:id(\\d+)', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      'DELETE FROM merchant_rename_rules WHERE id = $1 RETURNING id',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Rename rule not found' });
    }
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/transaction-attachments/:id ─────────────────

router.delete('/api/transaction-attachments/:id(\\d+)', requireParent, async (req, res) => {
  try {
    const attachment = await getVisibleAttachmentById(parseInt(req.params.id, 10), req.member);
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    await pool.query('DELETE FROM transaction_attachments WHERE id = $1', [attachment.id]);
    const deletedFromDisk = await safeDeleteAttachmentFile(attachment.stored_filename);
    logger.info('Transaction attachment deleted', {
      transactionId: attachment.transaction_id,
      attachmentId: attachment.id,
      deletedFromDisk
    });

    res.json({ success: true, id: attachment.id, deleted_from_disk: deletedFromDisk });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/bulk-categorize ───────────────────

router.post('/api/transactions/bulk-categorize', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const { transaction_ids, category_id } = req.body;

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return res.status(400).json({ error: 'transaction_ids must be a non-empty array' });
    }
    if (transaction_ids.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 transactions per bulk operation' });
    }

    const { rowCount } = await pool.query(
      'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = ANY($2::int[])',
      [category_id, transaction_ids]
    );

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/:id/create-rule ───────────────────

router.post('/api/transactions/:id/create-rule', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const { id } = req.params;
    const { category_id } = req.body;

    const result = await withTransaction(async (client) => {
      // Get transaction merchant
      const { rows: txRows } = await client.query(
        'SELECT merchant_name, name FROM transactions WHERE id = $1', [id]
      );
      if (txRows.length === 0) {
        throw Object.assign(new Error('Transaction not found'), { status: 404 });
      }

      const merchantPattern = txRows[0].merchant_name || txRows[0].name;
      if (!merchantPattern) {
        throw Object.assign(new Error('Transaction has no merchant name to create rule from'), { status: 400 });
      }

      // Update transaction category
      await client.query(
        'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = $2',
        [category_id, id]
      );

      // Create rule
      const { rows: ruleRows } = await client.query(
        `INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by)
         VALUES ($1, $2, 'contains', 'user')
         RETURNING id, merchant_pattern, category_id, match_type`,
        [merchantPattern, category_id]
      );

      return ruleRows[0];
    });

    res.json({ success: true, rule: result });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
