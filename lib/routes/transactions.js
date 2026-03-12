'use strict';

const { Router } = require('express');
const { pool, withTransaction } = require('../db');

const router = Router();

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

    // Build WHERE clause dynamically
    const conditions = [];
    const params = [];
    let idx = 1;

    if (!showTransfers) {
      conditions.push('t.is_transfer = false');
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
        conditions.push('t.category_id IS NULL');
      } else {
        conditions.push(`t.category_id = $${idx++}`);
        params.push(parseInt(categoryId));
      }
    }

    if (search) {
      conditions.push(`(t.merchant_name ILIKE $${idx} OR t.name ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
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
             t.category_id,
             a.name AS account_name, a.mask AS account_mask, a.type AS account_type,
             c.name AS category_name, c.color AS category_color, c.icon AS category_icon
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      LEFT JOIN categories c ON t.category_id = c.id
      ${whereClause}
      ORDER BY t.date DESC, t.id DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(dataQuery, dataParams);

    res.json({
      transactions: rows,
      total: stats.total,
      sum: parseFloat(stats.sum),
      limit,
      offset
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/transactions/:id/category ───────────────────────

router.put('/api/transactions/:id/category', async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id } = req.body;

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

// ── POST /api/transactions/bulk-categorize ───────────────────

router.post('/api/transactions/bulk-categorize', async (req, res) => {
  try {
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
