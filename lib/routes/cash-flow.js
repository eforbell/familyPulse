'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { requireAuth, requireParent } = require('../auth');
const { getForecast, computeAndCacheForecast } = require('../forecast-service');

const router = Router();

async function invalidateForecastCache() {
  await pool.query('DELETE FROM cash_flow_snapshots');
}

// --- Planned Expenses CRUD ---

router.get('/api/cash-flow/planned-expenses', requireParent, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pe.*, fm.name AS created_by_name
      FROM planned_expenses pe
      LEFT JOIN family_members fm ON pe.created_by = fm.id
      WHERE pe.status = 'active'
      ORDER BY pe.scheduled_date ASC, pe.name ASC
    `);
    res.json({ planned_expenses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/cash-flow/planned-expenses', requireParent, async (req, res) => {
  try {
    const { name, amount, scheduled_date, notes } = req.body;
    const errors = validatePlannedExpense({ name, amount, scheduled_date });
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const memberId = req.member ? req.member.id : null;
    const { rows: [row] } = await pool.query(`
      INSERT INTO planned_expenses (name, amount, scheduled_date, notes, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name.trim(), amount, scheduled_date, notes || null, memberId]);

    await invalidateForecastCache();
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/cash-flow/planned-expenses/:id', requireParent, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, amount, scheduled_date, status, notes } = req.body;

    // Validate only the fields being updated
    if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (name !== undefined && (!name || !name.trim())) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (status !== undefined && !['active', 'completed', 'deleted'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, completed, or deleted' });
    }
    if (scheduled_date !== undefined) {
      const d = new Date(scheduled_date + 'T00:00:00Z');
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'scheduled_date must be a valid date' });
      }
      const now = new Date();
      const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      if (d < currentMonthStart) {
        return res.status(400).json({ error: 'scheduled_date must be in the current month or future' });
      }
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name.trim()); }
    if (amount !== undefined) { sets.push(`amount = $${idx++}`); params.push(amount); }
    if (scheduled_date !== undefined) { sets.push(`scheduled_date = $${idx++}`); params.push(scheduled_date); }
    if (status !== undefined) { sets.push(`status = $${idx++}`); params.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(notes || null); }
    sets.push(`updated_at = now()`);

    if (sets.length === 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE planned_expenses SET ${sets.join(', ')} WHERE id = $${idx} AND status != 'deleted' RETURNING *`,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Planned expense not found' });
    }
    await invalidateForecastCache();
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/cash-flow/planned-expenses/:id', requireParent, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE planned_expenses SET status = 'deleted', updated_at = now() WHERE id = $1 AND status != 'deleted' RETURNING id`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Planned expense not found' });
    }
    await invalidateForecastCache();
    res.json({ deleted: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Forecast API ---

router.get('/api/cash-flow/forecast', requireParent, async (req, res) => {
  try {
    const cfg = req.app.get('cfg');
    const result = await getForecast(cfg);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/cash-flow/forecast/refresh', requireParent, async (req, res) => {
  try {
    const cfg = req.app.get('cfg');
    const result = await computeAndCacheForecast(cfg);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/cash-flow/danger-zones', requireParent, async (req, res) => {
  try {
    const cfg = req.app.get('cfg');
    const result = await getForecast(cfg);
    res.json({ danger_zones: result.danger_zones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/cash-flow/monthly-outlook', requireParent, async (req, res) => {
  try {
    const cfg = req.app.get('cfg');
    const result = await getForecast(cfg);
    res.json({
      monthly_outlook: result.monthly_outlook,
      excess_liquidity: result.excess_liquidity
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Validation ---

function validatePlannedExpense({ name, amount, scheduled_date }) {
  const errors = [];
  if (!name || !name.trim()) errors.push('name is required');
  if (typeof amount !== 'number' || amount <= 0) errors.push('amount must be a positive number');
  if (!scheduled_date) {
    errors.push('scheduled_date is required');
  } else {
    const d = new Date(scheduled_date + 'T00:00:00Z');
    if (isNaN(d.getTime())) {
      errors.push('scheduled_date must be a valid date');
    } else {
      // Allow dates in the current month or future
      const now = new Date();
      const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      if (d < currentMonthStart) {
        errors.push('scheduled_date must be in the current month or future');
      }
    }
  }
  return errors;
}

module.exports = router;
