'use strict';

const { Router } = require('express');
const crypto = require('node:crypto');
const multer = require('multer');
const { pool, withTransaction } = require('../db');
const { parse } = require('../monarch-parser');
const { suggestMappings } = require('../category-mapper');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── POST /api/import/upload — Parse CSV and return preview ──

router.post('/api/import/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = parse(req.file.buffer);

    if (result.errors.length > 0 && result.rows.length === 0) {
      return res.status(400).json({ error: 'CSV parsing failed', errors: result.errors });
    }

    // Get FP categories for mapping suggestions
    const { rows: fpCategories } = await pool.query(
      'SELECT id, name FROM categories ORDER BY name'
    );

    const mappingSuggestions = suggestMappings(result.categories, fpCategories);

    // Get existing accounts for account mapping
    const { rows: fpAccounts } = await pool.query(
      `SELECT a.id, a.name, a.mask, a.type, a.owner
       FROM accounts a JOIN items i ON a.item_id = i.id
       WHERE i.item_id != 'monarch-import'
       ORDER BY a.name`
    );

    res.json({
      filename: req.file.originalname,
      totalRows: result.rows.length,
      parseErrors: result.errors,
      preview: result.rows.slice(0, 20),
      monarchCategories: result.categories,
      monarchAccounts: result.accounts,
      categorySuggestions: mappingSuggestions,
      fpCategories,
      fpAccounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/import/commit — Import transactions ───────────

router.post('/api/import/commit', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // categoryMap and accountMap come as JSON strings in multipart form fields
    const categoryMap = JSON.parse(req.body.categoryMap || '{}');
    const accountMap = JSON.parse(req.body.accountMap || '{}');

    const result = parse(req.file.buffer);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'No valid rows to import' });
    }

    const summary = await withTransaction(async (client) => {
      // Create import run
      const { rows: [run] } = await client.query(
        `INSERT INTO import_runs (source, status, filename, category_mappings)
         VALUES ('monarch', 'running', $1, $2) RETURNING id`,
        [req.file.originalname, JSON.stringify(categoryMap)]
      );

      // Get or create the sentinel Monarch item
      const { rows: [monarchItem] } = await client.query(
        `SELECT id FROM items WHERE item_id = 'monarch-import'`
      );
      if (!monarchItem) {
        throw new Error('Monarch sentinel item not found — run migrations first');
      }

      // Resolve account mapping: Monarch account name → FP account id
      const accountIdMap = {};
      for (const monarchAcct of result.accounts) {
        if (accountMap[monarchAcct] === 'skip') {
          accountIdMap[monarchAcct] = null; // will be skipped during import
        } else if (accountMap[monarchAcct] && accountMap[monarchAcct] !== 'auto') {
          accountIdMap[monarchAcct] = parseInt(accountMap[monarchAcct]);
        } else {
          // Auto-create account under Monarch item
          const acctType = guessAccountType(monarchAcct);
          const mask = extractMask(monarchAcct);
          const { rows: [existing] } = await client.query(
            `SELECT id FROM accounts WHERE name = $1 AND item_id = $2`,
            [monarchAcct, monarchItem.id]
          );
          if (existing) {
            accountIdMap[monarchAcct] = existing.id;
          } else {
            const { rows: [newAcct] } = await client.query(
              `INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, owner)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [
                `monarch-${crypto.createHash('sha256').update(monarchAcct).digest('hex').substring(0, 16)}`,
                monarchItem.id, monarchAcct, acctType.type, acctType.subtype, mask, null
              ]
            );
            accountIdMap[monarchAcct] = newAcct.id;
          }
        }
      }

      let inserted = 0;
      let skipped = 0;
      const errors = [];

      for (const row of result.rows) {
        try {
          const accountId = accountIdMap[row.account];
          if (accountId === null) {
            skipped++; // account marked as "skip"
            continue;
          }
          if (accountId === undefined) {
            errors.push({ line: row._line, message: `No account mapping for "${row.account}"` });
            continue;
          }

          const fpCategoryId = categoryMap[row.category]
            ? parseInt(categoryMap[row.category])
            : null;

          // Monarch: negative = expense, positive = income
          // Plaid/FP: positive = expense, negative = income
          const amount = -row.amount;

          // Generate deterministic synthetic plaid_transaction_id for dedup
          const hash = crypto.createHash('sha256')
            .update(`${row.date}|${row.amount}|${row.merchant}|${row.account}|${row.originalStatement}`)
            .digest('hex')
            .substring(0, 24);
          const syntheticId = `monarch-${hash}`;

          const isTransfer = (row.category === 'Transfer' || row.category === 'Credit Card Payment'
            || row.category === 'Cash & ATM');
          const transferType = row.category === 'Credit Card Payment' ? 'cc_payment'
            : row.category === 'Cash & ATM' ? 'atm'
            : isTransfer ? 'transfer' : null;

          const { rowCount } = await client.query(
            `INSERT INTO transactions
              (plaid_transaction_id, account_id, amount, date, merchant_name, name,
               category_id, pending, is_transfer, transfer_type, source, raw_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, 'monarch', $10)
             ON CONFLICT (plaid_transaction_id) DO NOTHING`,
            [
              syntheticId, accountId, amount, row.date,
              row.merchant, row.originalStatement,
              fpCategoryId, isTransfer, transferType,
              JSON.stringify(row)
            ]
          );

          if (rowCount > 0) inserted++;
          else skipped++;
        } catch (rowErr) {
          errors.push({ line: row._line, message: rowErr.message });
        }
      }

      // Update import run
      await client.query(
        `UPDATE import_runs SET status = 'complete', txns_added = $1, txns_skipped = $2,
         errors = $3, finished_at = now() WHERE id = $4`,
        [inserted, skipped, errors.length > 0 ? JSON.stringify(errors) : null, run.id]
      );

      return { importRunId: run.id, inserted, skipped, errors: errors.length, totalRows: result.rows.length };
    });

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/import/history — Past import runs ──────────────

router.get('/api/import/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, source, status, filename, txns_added, txns_skipped, errors,
              started_at, finished_at
       FROM import_runs WHERE source = 'monarch'
       ORDER BY started_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ─────────────────────────────────────────────────

function guessAccountType(name) {
  const lower = name.toLowerCase();
  if (lower.includes('savings') || lower.includes('cd') || lower.includes('certificate'))
    return { type: 'depository', subtype: 'savings' };
  if (lower.includes('checking'))
    return { type: 'depository', subtype: 'checking' };
  if (lower.includes('amex') || lower.includes('visa') || lower.includes('credit') || lower.includes('quicksilver'))
    return { type: 'credit', subtype: 'credit card' };
  return { type: 'depository', subtype: 'checking' };
}

function extractMask(name) {
  const match = name.match(/\((?:\.\.\.)?(\d+)\)/);
  return match ? match[1] : null;
}

module.exports = router;
