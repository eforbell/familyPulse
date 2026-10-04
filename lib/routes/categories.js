'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { categorizeMany, applyRulesRetroactive, previewRule } = require('../categorization');
const { invalidateForecastCache } = require('../forecast-service');

const router = Router();

// ── GET /api/categories ──────────────────────────────────────

router.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, count(DISTINCT t.id)::int AS transaction_count
      FROM categories c
      LEFT JOIN transaction_allocations ta ON ta.category_id = c.id
      LEFT JOIN transactions t ON t.id = ta.transaction_id AND t.is_hidden = false
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
    const { name, color, budget_amount, is_income, is_transfer_class, icon, exclude_from_baseline, exclude_from_learning, exclude_from_spending } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { rows } = await pool.query(`
      INSERT INTO categories (name, color, budget_amount, is_income, is_transfer_class, icon, exclude_from_baseline, exclude_from_learning, exclude_from_spending)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, color || '#6b7280', budget_amount || null, !!is_income, !!is_transfer_class, icon || null, !!exclude_from_baseline, !!exclude_from_learning, !!exclude_from_spending]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Category with this name already exists' });
    }
    if (err.code === '23514') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/categories/:id ──────────────────────────────────

router.put('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, budget_amount, is_income, is_transfer_class, icon, exclude_from_baseline, exclude_from_learning, exclude_from_spending } = req.body;

    const { rows: [current] } = await pool.query(
      `SELECT c.*, pcm.field_key AS paycheck_field_key
       FROM categories c
       LEFT JOIN paycheck_category_mappings pcm ON pcm.category_id = c.id
       WHERE c.id = $1`,
      [id]
    );
    if (!current) return res.status(404).json({ error: 'Category not found' });
    if (current.paycheck_field_key) {
      const changesPayrollSemantics = (
        (name !== undefined && name !== current.name)
        || (is_income !== undefined && is_income !== current.is_income)
        || (is_transfer_class !== undefined && is_transfer_class !== current.is_transfer_class)
        || (exclude_from_baseline !== undefined && exclude_from_baseline !== current.exclude_from_baseline)
        || (exclude_from_learning !== undefined && exclude_from_learning !== current.exclude_from_learning)
      );
      // exclude_from_spending is deliberately absent: it is a reporting
      // preference, so a household may opt a deduction back into spending.
      if (changesPayrollSemantics) {
        return res.status(409).json({ error: 'Paycheck category semantics cannot be changed.' });
      }
    }

    const { rows } = await pool.query(`
      UPDATE categories
      SET name = COALESCE($1, name),
          color = COALESCE($2, color),
          budget_amount = CASE WHEN $11 THEN $3 ELSE budget_amount END,
          is_income = COALESCE($4, is_income),
          is_transfer_class = COALESCE($5, is_transfer_class),
          icon = CASE WHEN $12 THEN $6 ELSE icon END,
          exclude_from_baseline = COALESCE($7, exclude_from_baseline),
          exclude_from_learning = COALESCE($8, exclude_from_learning),
          exclude_from_spending = COALESCE($9, exclude_from_spending)
      WHERE id = $10
      RETURNING *
    `, [
      name, color, budget_amount ?? null, is_income, is_transfer_class, icon ?? null,
      exclude_from_baseline, exclude_from_learning, exclude_from_spending, id,
      // budget_amount and icon are clearable, so null can't mean "unchanged".
      // Only touch them when the request actually sends them; the inline
      // Admin toggles send a single flag and used to wipe both.
      Object.hasOwn(req.body, 'budget_amount'), Object.hasOwn(req.body, 'icon')
    ]);

    if (exclude_from_baseline !== undefined) {
      await invalidateForecastCache();
    }

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Category with this name already exists' });
    }
    if (err.code === '23514') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/categories/:id ───────────────────────────────

router.delete('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: [paycheckMapping] } = await pool.query(
      'SELECT field_key FROM paycheck_category_mappings WHERE category_id = $1',
      [id]
    );
    if (paycheckMapping) {
      return res.status(409).json({ error: 'Cannot delete a category used by paycheck setup.' });
    }

    // Check for assigned transactions
    const { rows: [count] } = await pool.query(
      `SELECT count(DISTINCT ta.transaction_id)::int AS count
       FROM transaction_allocations ta
       WHERE ta.category_id = $1`, [id]
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
