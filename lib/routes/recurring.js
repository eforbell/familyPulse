'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { requireAuth, requireParent } = require('../auth');
const { getRecurringSummary } = require('../recurring-detector');

const router = Router();

router.get('/api/recurring', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT re.*, a.name AS account_name
      FROM recurring_expenses re
      LEFT JOIN accounts a ON re.latest_account_id = a.id
      ORDER BY re.latest_amount DESC, re.merchant_name ASC
    `);
    res.json({ recurring: rows.map(formatRecurringRow) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/recurring/summary', requireAuth, async (req, res) => {
  try {
    res.json(await getRecurringSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/recurring/calendar', requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days || '30', 10) || 30, 90));
    const { rows } = await pool.query(`
      SELECT re.*, a.name AS account_name
      FROM recurring_expenses re
      LEFT JOIN accounts a ON re.latest_account_id = a.id
      WHERE re.status = 'active'
        AND re.confidence IN ('medium', 'high')
        AND re.expected_next_date IS NOT NULL
        AND re.expected_next_date >= current_date
        AND re.expected_next_date <= current_date + $1::int
      ORDER BY re.expected_next_date ASC, re.latest_amount DESC
    `, [days]);

    res.json({
      days,
      calendar: rows.map(row => ({
        merchant_name: row.merchant_name,
        cashflow_type: row.cashflow_type,
        expected_amount: roundMoney(row.latest_amount),
        expected_date: row.expected_next_date,
        account_name: row.account_name,
        frequency: row.frequency,
        confidence: row.confidence
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/recurring/:id/history', requireAuth, async (req, res) => {
  try {
    const recurringId = parseInt(req.params.id, 10);
    if (!Number.isInteger(recurringId)) {
      return res.status(400).json({ error: 'Invalid recurring id' });
    }

    const { rows } = await pool.query(`
      SELECT amount, transaction_date
      FROM recurring_expense_history
      WHERE recurring_expense_id = $1
      ORDER BY transaction_date DESC
    `, [recurringId]);

    res.json({
      history: rows.map(row => ({
        amount: roundMoney(row.amount),
        transaction_date: formatDate(row.transaction_date)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/recurring/:id', requireParent, async (req, res) => {
  try {
    const recurringId = parseInt(req.params.id, 10);
    if (!Number.isInteger(recurringId)) {
      return res.status(400).json({ error: 'Invalid recurring id' });
    }

    const allowedStatuses = new Set(['active', 'paused', 'ignored']);
    const status = req.body?.status;
    const overrideFrequency = req.body?.override_frequency || null;
    const overrideExpectedNextDate = req.body?.override_expected_next_date || null;

    if (status != null && !allowedStatuses.has(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const { rowCount, rows } = await pool.query(`
      UPDATE recurring_expenses
      SET status = COALESCE($1, status),
          override_frequency = COALESCE($2, override_frequency),
          override_expected_next_date = COALESCE($3, override_expected_next_date),
          expected_next_date = COALESCE($3, expected_next_date),
          updated_at = now()
      WHERE id = $4
      RETURNING *
    `, [status, overrideFrequency, overrideExpectedNextDate, recurringId]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Recurring item not found' });
    }

    res.json({ recurring: formatRecurringRow(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatRecurringRow(row) {
  return {
    id: row.id,
    merchant_name: row.merchant_name,
    cashflow_type: row.cashflow_type,
    frequency: row.override_frequency || row.frequency,
    confidence: row.confidence,
    status: row.status,
    account_name: row.account_name || null,
    latest_amount: roundMoney(row.latest_amount),
    prior_amount: row.prior_amount == null ? null : roundMoney(row.prior_amount),
    price_change_pct: row.price_change_pct == null ? null : Number(row.price_change_pct),
    price_change_direction: row.price_change_direction || null,
    price_change_date: formatDate(row.price_change_date),
    first_seen_date: formatDate(row.first_seen_date),
    last_seen_date: formatDate(row.last_seen_date),
    expected_next_date: formatDate(row.override_expected_next_date || row.expected_next_date),
    interval_days: row.interval_days,
    tolerance_days: row.tolerance_days
  };
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

module.exports = router;
