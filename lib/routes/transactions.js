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
const {
  fingerprintForTransaction,
  captureManualLearning,
  captureManualLearningForTransactionIds,
  rejectSuggestion
} = require('../learned-categorization');
const {
  getTransactionAllocations,
  replaceTransactionAllocations,
  setSingleTransactionCategory
} = require('../transaction-allocations');
const {
  getPaycheck,
  getLatestPaycheckTemplate,
  savePaycheck
} = require('../paychecks');

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

function applyAllocationSummary(transaction, allocations = []) {
  const categoryAllocations = allocations.map(allocation => ({
    id: allocation.id,
    category_id: allocation.category_id,
    amount: allocation.amount,
    position: allocation.position,
    category_name: allocation.category_name || null,
    category_color: allocation.category_color || null,
    category_icon: allocation.category_icon || null,
    is_income: allocation.is_income ?? null,
    is_transfer_class: allocation.is_transfer_class ?? null
  }));
  const single = categoryAllocations.length === 1 ? categoryAllocations[0] : null;
  const allocationSigns = new Set(categoryAllocations
    .map(allocation => Number(allocation.amount))
    .filter(amount => amount !== 0)
    .map(amount => amount < 0 ? -1 : 1));
  return {
    ...transaction,
    category_id: single?.category_id ?? null,
    category_name: single?.category_name ?? null,
    category_color: single?.category_color ?? null,
    category_icon: single?.category_icon ?? null,
    category_allocations: categoryAllocations,
    is_split: categoryAllocations.length > 1,
    is_compound: allocationSigns.size > 1
  };
}

function serializeTransactionDetail(transaction, attachments, allocations = []) {
  const rawDisplayName = getRawSourceText(transaction) || null;
  return {
    ...applyAllocationSummary(transaction, allocations),
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

async function getAllocationsForTransaction(transactionId, client = pool) {
  return getTransactionAllocations(client, transactionId);
}

async function serializeVisibleTransaction(transaction, member) {
  const [attachments, allocations, paycheck] = await Promise.all([
    getAttachmentsForTransaction(transaction.id),
    getAllocationsForTransaction(transaction.id),
    member?.role === 'kid' ? null : getPaycheck(pool, transaction.id)
  ]);
  return { ...serializeTransactionDetail(transaction, attachments, allocations), paycheck };
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
            t.source, t.is_hidden, t.hidden_reason, t.duplicate_of_transaction_id,
            t.merchant_fingerprint, t.categorization_source, t.suggested_category_id, t.suggestion_source,
            t.source_removed, t.source_removed_at, t.created_at, t.updated_at,
            t.display_name_override, t.display_name_override_updated_at,
            COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask,
            a.type AS account_type, a.sync_status AS account_sync_status,
            sc.name AS suggested_category_name, sc.color AS suggested_category_color, sc.icon AS suggested_category_icon,
            tn.note, tn.updated_at AS note_updated_at, fm.name AS note_updated_by_name,
            fm_override.name AS display_name_override_updated_by_name,
            mrr.id AS rename_rule_id, mrr.raw_source_text AS rename_rule_raw_source_text,
            mrr.display_name AS rename_rule_display_name, mrr.updated_at AS rename_rule_updated_at
     FROM transactions t
     JOIN accounts a ON t.account_id = a.id
     LEFT JOIN categories sc ON t.suggested_category_id = sc.id
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
    const isUncategorizedFilter = categoryId === '0';
    const dedupRunId = req.query.dedup_run_id ? parseInt(req.query.dedup_run_id, 10) : null;
    const allowedSortFields = new Set(['date', 'amount']);
    const allowedSortDirections = new Set(['asc', 'desc']);
    const sortField = allowedSortFields.has(req.query.sort_field) ? req.query.sort_field : 'date';
    const sortDirection = allowedSortDirections.has(req.query.sort_direction) ? req.query.sort_direction : 'desc';

    // Build WHERE clause dynamically
    const conditions = [];
    const params = [];
    let idx = 1;
    let categoryFilterParamIndex = null;

    const hasSpecificCategory = categoryId !== undefined && categoryId !== '' && categoryId !== '0';
    if (!showTransfers && !isUncategorizedFilter && !hasSpecificCategory) {
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
          EXISTS (
            SELECT 1
            FROM transaction_allocations ta_filter
            LEFT JOIN categories c_filter ON c_filter.id = ta_filter.category_id
            WHERE ta_filter.transaction_id = t.id
              AND (ta_filter.category_id IS NULL OR c_filter.name = 'Uncategorized')
          )
        )`);
      } else {
        categoryFilterParamIndex = idx++;
        conditions.push(`EXISTS (
          SELECT 1 FROM transaction_allocations ta_filter
          WHERE ta_filter.transaction_id = t.id
            AND ta_filter.category_id = $${categoryFilterParamIndex}
        )`);
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
    const filteredAmountExpression = categoryId === '0'
      ? `(SELECT COALESCE(SUM(ta_sum.amount), 0)
          FROM transaction_allocations ta_sum
          LEFT JOIN categories c_sum ON c_sum.id = ta_sum.category_id
          WHERE ta_sum.transaction_id = t.id
            AND (ta_sum.category_id IS NULL OR c_sum.name = 'Uncategorized'))`
      : categoryFilterParamIndex
        ? `(SELECT COALESCE(SUM(ta_sum.amount), 0)
            FROM transaction_allocations ta_sum
            WHERE ta_sum.transaction_id = t.id
              AND ta_sum.category_id = $${categoryFilterParamIndex})`
        : 't.amount';
    const countQuery = `
      SELECT count(*)::int AS total, COALESCE(sum(${filteredAmountExpression}), 0)::numeric AS sum
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      ${whereClause}
    `;
    const { rows: [stats] } = await pool.query(countQuery, params);

    // Get paginated transactions
    const dataQuery = `
      SELECT t.id, t.plaid_transaction_id, t.amount, t.date, t.authorized_date,
             t.merchant_name, t.name, t.pending, t.is_transfer, t.transfer_type,
             t.source, t.is_hidden, t.hidden_reason, t.duplicate_of_transaction_id,
             t.merchant_fingerprint, t.categorization_source, t.suggested_category_id, t.suggestion_source,
             t.display_name_override,
             COALESCE(t.display_name_override, t.merchant_name, t.name) AS effective_display_name,
             COALESCE(t.merchant_name, t.name) AS raw_display_name,
             COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask,
             a.type AS account_type, a.sync_status AS account_sync_status,
             sc.name AS suggested_category_name, sc.color AS suggested_category_color, sc.icon AS suggested_category_icon,
             COALESCE(alloc.category_allocations, '[]'::json) AS category_allocations
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories sc ON t.suggested_category_id = sc.id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', ta.id,
            'transaction_id', ta.transaction_id,
            'category_id', ta.category_id,
            'amount', ta.amount::text,
            'position', ta.position,
            'category_name', ac.name,
            'category_color', ac.color,
            'category_icon', ac.icon,
            'is_income', ac.is_income,
            'is_transfer_class', ac.is_transfer_class
          ) ORDER BY ta.position, ta.id
        ) AS category_allocations
        FROM transaction_allocations ta
        LEFT JOIN categories ac ON ac.id = ta.category_id
        WHERE ta.transaction_id = t.id
      ) alloc ON true
      ${whereClause}
      ORDER BY ${sortField === 'amount' ? 'ABS(t.amount)' : 't.date'} ${sortDirection.toUpperCase()}, t.date DESC, t.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);
    const serializedRows = rows.map(row => {
      const allocations = row.category_allocations || [];
      delete row.category_allocations;
      return applyAllocationSummary(row, allocations);
    });

    res.json({
      transactions: serializedRows,
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
      transaction: await serializeVisibleTransaction(transaction, req.member)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Paycheck setup ──────────────────────────────────────────

router.get('/api/transactions/:id(\\d+)/paycheck-setup', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const transaction = await getVisibleTransactionById(id, req.member);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const paycheck = await getPaycheck(pool, id);
    const employer = computeEffectiveDisplayName(transaction) || transaction.merchant_name || transaction.name || '';
    const memberId = paycheck?.member_id || req.member.id;
    const [template, membersResult] = await Promise.all([
      paycheck ? null : getLatestPaycheckTemplate(pool, { memberId, employer, excludeTransactionId: id }),
      pool.query(
        `SELECT id, name, role, avatar_emoji
         FROM family_members
         WHERE role <> 'kid'
         ORDER BY name, id`
      )
    ]);

    res.json({
      transaction: {
        id: transaction.id,
        amount: transaction.amount,
        pending: transaction.pending,
        is_transfer: transaction.is_transfer,
        employer
      },
      members: membersResult.rows,
      paycheck,
      latest_template: template
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/api/paychecks/template', requireParent, async (req, res) => {
  try {
    const memberId = Number(req.query.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return res.status(400).json({ error: 'A valid member_id is required' });
    }
    const template = await getLatestPaycheckTemplate(pool, {
      memberId,
      employer: String(req.query.employer || '').trim() || null,
      excludeTransactionId: Number(req.query.exclude_transaction_id) || null
    });
    res.json({ template });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/api/transactions/:id(\\d+)/paycheck', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const paycheck = await withTransaction(client => savePaycheck(client, {
      transactionId: id,
      input: req.body,
      createdBy: req.member.id
    }));
    res.json({ success: true, paycheck });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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

    if (member && member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }

    const updated = await withTransaction(async (client) => {
      const { rows: txRows } = await client.query(
        `SELECT id, merchant_name, name, merchant_fingerprint
         FROM transactions
         WHERE id = $1`,
        [id]
      );
      if (txRows.length === 0) return null;
      const tx = txRows[0];
      const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
      await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, id]);
      const result = await setSingleTransactionCategory(client, {
        transactionId: id,
        categoryId: category_id,
        memberId: member?.id,
        categorizationSource: 'manual'
      });
      await captureManualLearning(client, { ...tx, merchant_fingerprint: fingerprint }, category_id);
      return result;
    });

    if (!updated) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ success: true, id: Number(id), allocations: updated.allocations });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/allocations ───────────────────

router.put('/api/transactions/:id(\\d+)/allocations', requireParent, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allocations = req.body?.allocations;
    const result = await withTransaction(async (client) => {
      const { rows: [tx] } = await client.query(
        `SELECT id, merchant_name, name, merchant_fingerprint
         FROM transactions WHERE id = $1`,
        [id]
      );
      if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
      await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, id]);
      const replaced = await replaceTransactionAllocations(client, {
        transactionId: id,
        allocations,
        memberId: req.member.id,
        categorizationSource: 'manual'
      });
      if (replaced.allocations.length === 1 && replaced.allocations[0].category_id) {
        await captureManualLearning(client, { ...tx, merchant_fingerprint: fingerprint }, replaced.allocations[0].category_id);
      }
      return replaced;
    });
    res.json({ success: true, id, allocations: result.allocations });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
      return res.json({ success: true, transaction: await serializeVisibleTransaction(refreshed, req.member) });
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
      transaction: await serializeVisibleTransaction(refreshed, req.member)
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
      transaction: await serializeVisibleTransaction(refreshed, req.member)
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
      transaction: await serializeVisibleTransaction(refreshed, req.member)
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

// ── GET /api/learned-category-rules ──────────────────────────

router.get('/api/learned-category-rules', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const { rows } = await pool.query(
      `SELECT lcr.id, lcr.merchant_fingerprint, lcr.category_id, c.name AS category_name,
              c.color AS category_color, lcr.occurrence_count, lcr.first_seen_at,
              lcr.last_seen_at, lcr.last_applied_at, lcr.created_at, lcr.updated_at,
              COALESCE(
                json_agg(
                  json_build_object(
                    'category_id', sr.category_id,
                    'category_name', rc.name,
                    'rejected_at', sr.rejected_at
                  )
                ) FILTER (WHERE sr.id IS NOT NULL),
                '[]'::json
              ) AS rejections
       FROM learned_category_rules lcr
       JOIN categories c ON c.id = lcr.category_id
       LEFT JOIN suggestion_rejections sr ON sr.merchant_fingerprint = lcr.merchant_fingerprint
       LEFT JOIN categories rc ON rc.id = sr.category_id
       GROUP BY lcr.id, c.id
       ORDER BY lcr.updated_at DESC, lcr.id DESC`
    );
    res.json({ rules: rows });
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

    const rowCount = await withTransaction(async (client) => {
      const { rows: txRows } = await client.query(
        `SELECT id, merchant_name, name, merchant_fingerprint
         FROM transactions
         WHERE id = ANY($1::int[])`,
        [transaction_ids]
      );
      for (const tx of txRows) {
        const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
        if (fingerprint !== tx.merchant_fingerprint) {
          await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, tx.id]);
        }
      }
      for (const tx of txRows) {
        await setSingleTransactionCategory(client, {
          transactionId: tx.id,
          categoryId: category_id,
          memberId: req.member?.id,
          categorizationSource: 'manual'
        });
      }
      await captureManualLearningForTransactionIds(client, transaction_ids, category_id);
      return txRows.length;
    });

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/:id/category-suggestion/accept ─────

router.post('/api/transactions/:id(\\d+)/category-suggestion/accept', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const id = parseInt(req.params.id, 10);
    const result = await withTransaction(async (client) => {
      const { rows: [tx] } = await client.query(
        `SELECT id, merchant_name, name, merchant_fingerprint, suggested_category_id
         FROM transactions
         WHERE id = $1`,
        [id]
      );
      if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      if (!tx.suggested_category_id) throw Object.assign(new Error('Transaction has no category suggestion'), { status: 400 });
      const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
      await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, id]);
      const updated = await setSingleTransactionCategory(client, {
        transactionId: id,
        categoryId: tx.suggested_category_id,
        memberId: req.member?.id,
        categorizationSource: 'manual'
      });
      await captureManualLearning(client, { ...tx, merchant_fingerprint: fingerprint }, tx.suggested_category_id);
      return { id, category_id: tx.suggested_category_id, allocations: updated.allocations };
    });
    res.json({ success: true, id: result.id, category_id: result.category_id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /api/transactions/:id/category-suggestion/reject ─────

router.post('/api/transactions/:id(\\d+)/category-suggestion/reject', async (req, res) => {
  try {
    if (req.member && req.member.role === 'kid') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const id = parseInt(req.params.id, 10);
    await withTransaction(async (client) => {
      const { rows: [tx] } = await client.query(
        `SELECT id, merchant_name, name, merchant_fingerprint, suggested_category_id
         FROM transactions
         WHERE id = $1`,
        [id]
      );
      if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      if (!tx.suggested_category_id) throw Object.assign(new Error('Transaction has no category suggestion'), { status: 400 });
      const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
      await rejectSuggestion(client, {
        transactionId: id,
        fingerprint,
        categoryId: tx.suggested_category_id,
        memberId: req.member?.id
      });
      await client.query(
        `UPDATE transactions
         SET merchant_fingerprint = $1,
             suggested_category_id = NULL,
             suggestion_source = NULL,
             updated_at = now()
         WHERE id = $2`,
        [fingerprint, id]
      );
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
        'SELECT id, merchant_name, name, merchant_fingerprint FROM transactions WHERE id = $1', [id]
      );
      if (txRows.length === 0) {
        throw Object.assign(new Error('Transaction not found'), { status: 404 });
      }

      const merchantPattern = txRows[0].merchant_name || txRows[0].name;
      if (!merchantPattern) {
        throw Object.assign(new Error('Transaction has no merchant name to create rule from'), { status: 400 });
      }

      // Update transaction category
      const fingerprint = txRows[0].merchant_fingerprint || fingerprintForTransaction(txRows[0]);
      await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, id]);
      await setSingleTransactionCategory(client, {
        transactionId: id,
        categoryId: category_id,
        memberId: req.member?.id,
        categorizationSource: 'manual'
      });
      await captureManualLearning(client, { ...txRows[0], merchant_fingerprint: fingerprint }, category_id);

      // Create rule
      const { rows: ruleRows } = await client.query(
        `INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by)
         VALUES ($1, $2, 'contains', 'user')
         RETURNING id, merchant_pattern, category_id, match_type`,
        [merchantPattern, category_id]
      );

      const { rows: matchedTransactions } = await client.query(
        `SELECT t.id
         FROM transactions t
         WHERE t.is_transfer = false
           AND t.is_hidden = false
           AND t.pending = false
           AND NOT EXISTS (
             SELECT 1 FROM transaction_allocations ta
             LEFT JOIN categories c ON c.id = ta.category_id
             WHERE ta.transaction_id = t.id
               AND ta.category_id IS NOT NULL
               AND c.name <> 'Uncategorized'
           )
           AND (
             LOWER(COALESCE(t.merchant_name, '')) LIKE '%' || LOWER($1) || '%'
             OR LOWER(COALESCE(t.name, '')) LIKE '%' || LOWER($1) || '%'
           )`,
        [merchantPattern]
      );
      for (const matched of matchedTransactions) {
        await setSingleTransactionCategory(client, {
          transactionId: matched.id,
          categoryId: category_id,
          categorizationSource: 'rule'
        });
      }

      return ruleRows[0];
    });

    res.json({ success: true, rule: result });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
