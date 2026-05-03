'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { app } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let baseUrl;
let parentSessionToken;
let kidSessionToken;
let recurringId;
let recurringIncomeId;
let accountId;

function req(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${parentSessionToken}`,
      ...opts.headers
    }
  });
}

describe('recurring API', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '014-recurring-expenses.sql'),
      'utf8'
    );
    await pool.query(migrationSql);

    const { rows: parents } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1"
    );
    const { rows: kids } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'kid' ORDER BY id LIMIT 1"
    );
    const parentId = parents[0].id;
    const kidId = kids[0].id;

    parentSessionToken = crypto.randomUUID();
    kidSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3), ($4, $5, $6)',
      [parentSessionToken, parentId, expiresAt, kidSessionToken, kidId, expiresAt]
    );

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-recurring', 'test-item-recurring', 'ins_recurring', 'Recurring Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);

    const { rows: [account] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-recurring-test', $1, 'Recurring Checking', 'depository', 'checking', '1234', 4000.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Recurring Checking'
      RETURNING id
    `, [item.id]);
    accountId = account.id;

    const recurringExpense = await pool.query(`
      INSERT INTO recurring_expenses (
        merchant_key, merchant_name, cashflow_type, frequency, confidence, status,
        latest_account_id, latest_amount, prior_amount, price_change_pct, price_change_direction,
        price_change_date, first_seen_date, last_seen_date, expected_next_date, interval_days,
        tolerance_days, schedule_anchor_type, schedule_anchor_value, source_txn_count
      )
      VALUES (
        'netflix com', 'Netflix', 'expense', 'monthly', 'high', 'active',
        $1, 22.99, 15.49, 48.42, 'up',
        '2026-04-05', '2026-01-05', '2026-04-05', current_date + 5, 30,
        3, 'day_of_month', '5', 4
      )
      RETURNING id
    `, [accountId]);
    recurringId = recurringExpense.rows[0].id;

    const recurringIncome = await pool.query(`
      INSERT INTO recurring_expenses (
        merchant_key, merchant_name, cashflow_type, frequency, confidence, status,
        latest_account_id, latest_amount, first_seen_date, last_seen_date, expected_next_date,
        interval_days, tolerance_days, schedule_anchor_type, schedule_anchor_value, source_txn_count
      )
      VALUES (
        'acme payroll', 'ACME Payroll', 'income', 'biweekly', 'high', 'active',
        $1, 2500.00, '2026-01-09', '2026-03-20', current_date + 2,
        14, 2, 'weekday', '5', 6
      )
      RETURNING id
    `, [accountId]);
    recurringIncomeId = recurringIncome.rows[0].id;

    await pool.query(`
      INSERT INTO recurring_expense_history (recurring_expense_id, amount, transaction_date)
      VALUES ($1, 15.49, '2026-03-05'), ($1, 22.99, '2026-04-05')
      ON CONFLICT DO NOTHING
    `, [recurringId]);
  });

  after(async () => {
    await pool.query('DELETE FROM recurring_expense_history WHERE recurring_expense_id IN ($1, $2)', [recurringId, recurringIncomeId]);
    await pool.query('DELETE FROM recurring_expenses WHERE id IN ($1, $2)', [recurringId, recurringIncomeId]);
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-recurring-test'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-recurring'");
    await pool.query('DELETE FROM sessions WHERE token IN ($1, $2)', [parentSessionToken, kidSessionToken]);
    server.close();
    await pool.end();
  });

  it('GET /api/recurring returns recurring rows', async () => {
    const res = await req('api/recurring');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.recurring));
    assert.ok(data.recurring.some(row => row.id === recurringId));
  });

  it('GET /api/recurring/summary returns committed and income totals', async () => {
    const res = await req('api/recurring/summary');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.committed_monthly_total, 22.99);
    assert.equal(data.recurring_income_monthly_total, 5425);
    assert.ok(data.active_count >= 2);
  });

  it('GET /api/recurring/calendar returns upcoming items including income', async () => {
    const res = await req('api/recurring/calendar?days=30');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.calendar));
    assert.ok(data.calendar.some(item => item.merchant_name === 'Netflix'));
    assert.ok(data.calendar.some(item => item.merchant_name === 'ACME Payroll'));
    assert.ok(data.calendar.every(item => item.cashflow_type === 'expense' || item.cashflow_type === 'income'));
  });

  it('GET /api/recurring/:id/history returns newest-first amount history', async () => {
    const res = await req(`api/recurring/${recurringId}/history`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.history.length, 2);
    assert.equal(data.history[0].amount, 22.99);
    assert.equal(data.history[0].transaction_date, '2026-04-05');
  });

  it('PATCH /api/recurring/:id requires parent role', async () => {
    const res = await fetch(`${baseUrl}/api/recurring/${recurringId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fp_session=${kidSessionToken}`
      },
      body: JSON.stringify({ status: 'paused' })
    });
    assert.equal(res.status, 403);
  });

  it('PATCH /api/recurring/:id updates allowed fields', async () => {
    const res = await req(`api/recurring/${recurringId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'paused',
        override_frequency: 'monthly',
        override_expected_next_date: '2026-05-06'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.recurring.status, 'paused');
    assert.equal(data.recurring.expected_next_date, '2026-05-06');
  });
});
