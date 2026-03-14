'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { categorizeMany, applyRulesRetroactive, previewRule } = require('../categorization');

const router = Router();

// ── GET /api/categories ──────────────────────────────────────

router.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, count(t.id)::int AS transaction_count
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id AND t.is_hidden = false
      GROUP BY c.id
      ORDER BY c.is_transfer_class, c.is_income, c.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/categories ─────────────────────────────────────

router.post('/api/categories', async (req, res) => {
  try {
    const { name, color, budget_amount, is_income, is_transfer_class, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { rows } = await pool.query(`
      INSERT INTO categories (name, color, budget_amount, is_income, is_transfer_class, icon)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name, color || '#6b7280', budget_amount || null, !!is_income, !!is_transfer_class, icon || null]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Category with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/categories/:id ──────────────────────────────────

router.put('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, budget_amount, is_income, is_transfer_class, icon } = req.body;

    const { rows } = await pool.query(`
      UPDATE categories
      SET name = COALESCE($1, name),
          color = COALESCE($2, color),
          budget_amount = $3,
          is_income = COALESCE($4, is_income),
          is_transfer_class = COALESCE($5, is_transfer_class),
          icon = $6
      WHERE id = $7
      RETURNING *
    `, [name, color, budget_amount ?? null, is_income, is_transfer_class, icon ?? null, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Category with this name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/categories/:id ───────────────────────────────

router.delete('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check for assigned transactions
    const { rows: [count] } = await pool.query(
      'SELECT count(*)::int AS count FROM transactions WHERE category_id = $1 AND is_hidden = false', [id]
    );

    if (count.count > 0) {
      return res.status(409).json({
        error: `Cannot delete category with ${count.count} assigned transaction(s). Reassign them first.`
      });
    }

    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rules ───────────────────────────────────────────

router.get('/api/rules', async (req, res) => {
  try {
    if (req.member && req.member.role !== 'parent') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const { rows } = await pool.query(`
      SELECT cr.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
      FROM category_rules cr
      JOIN categories c ON cr.category_id = c.id
      ORDER BY cr.merchant_pattern
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rules ──────────────────────────────────────────

router.post('/api/rules', async (req, res) => {
  try {
    const { merchant_pattern, category_id, match_type } = req.body;
    if (!merchant_pattern || !category_id) {
      return res.status(400).json({ error: 'merchant_pattern and category_id are required' });
    }

    const { rows } = await pool.query(`
      INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by)
      VALUES ($1, $2, $3, 'user')
      RETURNING *
    `, [merchant_pattern, category_id, match_type || 'contains']);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/rules/:id ──────────────────────────────────────

router.put('/api/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { merchant_pattern, category_id, match_type } = req.body;

    const { rows } = await pool.query(`
      UPDATE category_rules
      SET merchant_pattern = COALESCE($1, merchant_pattern),
          category_id = COALESCE($2, category_id),
          match_type = COALESCE($3, match_type)
      WHERE id = $4
      RETURNING *
    `, [merchant_pattern, category_id, match_type, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/rules/:id ────────────────────────────────────

router.delete('/api/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM category_rules WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rules/preview ──────────────────────────────────

router.post('/api/rules/preview', async (req, res) => {
  try {
    const { pattern, match_type } = req.body;
    if (!pattern) return res.status(400).json({ error: 'pattern is required' });

    const matches = await previewRule(pattern, match_type || 'contains');
    res.json({ matches, count: matches.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rules/apply ────────────────────────────────────

router.post('/api/rules/apply', async (req, res) => {
  try {
    const result = await categorizeMany();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
