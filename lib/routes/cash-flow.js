'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { requireAuth, requireParent } = require('../auth');
const { getForecast, computeAndCacheForecast, invalidateForecastCache } = require('../forecast-service');
const { getActiveRecurringMerchantKeys } = require('../seasonal-baseline');
const { buildMerchantFingerprint } = require('../merchant-normalizer');

const router = Router();

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
    const { name, amount, scheduled_date, notes, type } = req.body;
    const errors = validatePlannedExpense({ name, amount, scheduled_date, type });
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const memberId = req.member ? req.member.id : null;
    const itemType = type === 'income' ? 'income' : 'expense';
    const { rows: [row] } = await pool.query(`
      INSERT INTO planned_expenses (name, amount, scheduled_date, notes, created_by, type)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [name.trim(), amount, scheduled_date, notes || null, memberId, itemType]);

    await invalidateForecastCache();
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/cash-flow/planned-expenses/:id', requireParent, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, amount, scheduled_date, status, notes, type } = req.body;

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
    if (type !== undefined && !['expense', 'income'].includes(type)) {
      return res.status(400).json({ error: 'type must be expense or income' });
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
    if (type !== undefined) { sets.push(`type = $${idx++}`); params.push(type); }
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

// --- Discretionary Breakdown ---

function groupDiscretionaryMerchants(txRows, recurringKeys) {
  const merchantMap = new Map();
  let recurringTotal = 0;
  let discretionaryTotal = 0;
  const seenMonths = new Set();

  for (const tx of txRows) {
    const dateStr = typeof tx.date === 'string' ? tx.date : tx.date.toISOString().slice(0, 10);
    seenMonths.add(dateStr.slice(0, 7));
    const amount = Math.abs(Number(tx.amount));
    const fingerprint = buildMerchantFingerprint(tx);

    if (recurringKeys.has(fingerprint)) {
      recurringTotal += amount;
      continue;
    }

    discretionaryTotal += amount;
    const displayName = tx.merchant_name || tx.name || 'Unknown';
    const key = fingerprint || displayName.toLowerCase();

    if (!merchantMap.has(key)) {
      merchantMap.set(key, {
        merchant: displayName,
        category: tx.category_name || 'Uncategorized',
        total: 0,
        transaction_count: 0
      });
    }
    const entry = merchantMap.get(key);
    entry.total += amount;
    entry.transaction_count++;
    if (displayName.length > entry.merchant.length) {
      entry.merchant = displayName;
    }
  }

  const monthCount = seenMonths.size || 1;
  const merchants = [...merchantMap.values()]
    .map(m => ({
      merchant: m.merchant,
      category: m.category,
      total: Math.round(m.total * 100) / 100,
      monthly_avg: Math.round((m.total / monthCount) * 100) / 100,
      transaction_count: m.transaction_count
    }))
    .sort((a, b) => b.total - a.total);

  return { merchants, monthCount, discretionaryTotal, recurringTotal };
}

router.get('/api/cash-flow/discretionary-breakdown', requireParent, async (req, res) => {
  try {
    const calMonth = parseInt(req.query.month, 10);
    if (!calMonth || calMonth < 1 || calMonth > 12) {
      return res.status(400).json({ error: 'month must be 1-12' });
    }

    const recurringKeys = await getActiveRecurringMerchantKeys();
    const cutoffDate = new Date();
    cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 18);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    // Try the specific calendar month first
    const { rows: txRows } = await pool.query(`
      SELECT t.amount, t.date, t.merchant_name, t.name,
             c.name AS category_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.date >= $1::date
        AND EXTRACT(MONTH FROM t.date) = $2
        AND t.amount > 0
        AND t.pending = false
        AND t.is_hidden = false
        AND t.is_transfer = false
        AND (c.is_income IS NULL OR c.is_income = false)
        AND (c.is_transfer_class IS NULL OR c.is_transfer_class = false)
        AND (c.exclude_from_baseline IS NULL OR c.exclude_from_baseline = false)
      ORDER BY t.date DESC
    `, [cutoffStr, calMonth]);

    let result = groupDiscretionaryMerchants(txRows, recurringKeys);
    let fallback = false;

    // If no data for this calendar month, fall back to all months
    // (mirrors the seasonal baseline fallback behavior)
    if (!result.merchants.length) {
      const { rows: allRows } = await pool.query(`
        SELECT t.amount, t.date, t.merchant_name, t.name,
               c.name AS category_name
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.date >= $1::date
          AND t.amount > 0
          AND t.pending = false
          AND t.is_hidden = false
          AND t.is_transfer = false
          AND (c.is_income IS NULL OR c.is_income = false)
          AND (c.is_transfer_class IS NULL OR c.is_transfer_class = false)
          AND (c.exclude_from_baseline IS NULL OR c.exclude_from_baseline = false)
        ORDER BY t.date DESC
      `, [cutoffStr]);
      result = groupDiscretionaryMerchants(allRows, recurringKeys);
      fallback = true;
    }

    const roundMoney = v => Math.round(v * 100) / 100;
    const monthlyAvg = roundMoney(result.discretionaryTotal / result.monthCount);

    // Compute proration for current month (partial month remaining)
    const now = new Date();
    const currentCalMonth = now.getUTCMonth() + 1;
    let proration = null;
    if (calMonth === currentCalMonth) {
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const daysRemaining = daysInMonth - now.getUTCDate() + 1; // include today
      const dailyRate = roundMoney(monthlyAvg / daysInMonth);
      proration = {
        days_in_month: daysInMonth,
        days_remaining: daysRemaining,
        daily_rate: dailyRate,
        prorated_amount: roundMoney(dailyRate * daysRemaining)
      };
    }

    res.json({
      month: calMonth,
      months_sampled: result.monthCount,
      fallback,
      discretionary_total: roundMoney(result.discretionaryTotal),
      discretionary_monthly_avg: monthlyAvg,
      recurring_total_excluded: roundMoney(result.recurringTotal),
      proration,
      merchants: result.merchants
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Validation ---

function validatePlannedExpense({ name, amount, scheduled_date, type }) {
  const errors = [];
  if (!name || !name.trim()) errors.push('name is required');
  if (typeof amount !== 'number' || amount <= 0) errors.push('amount must be a positive number');
  if (type !== undefined && !['expense', 'income'].includes(type)) {
    errors.push('type must be expense or income');
  }
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
