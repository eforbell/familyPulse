'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { detectRecurringCashflows, upsertRecurringCandidate } = require('../lib/recurring-detector');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let itemId;
let accountId;

before(async () => {
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '014-recurring-expenses.sql'),
    'utf8'
  );
  await pool.query(migrationSql);
  // 022 redefines the identity index (drops the volatile schedule anchor); apply
  // it so this file is self-contained when run in isolation.
  await pool.query(fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '022-recurring-identity-drop-anchor.sql'),
    'utf8'
  ));

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-recurring-db', 'test-item-recurring-db', 'ins_recurring_db', 'Recurring Detector DB', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  itemId = item.id;

  const { rows: [account] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
    VALUES ('acct-recurring-db', $1, 'Recurring DB Checking', 'depository', 'checking', '5555', 5000.00)
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Recurring DB Checking'
    RETURNING id
  `, [itemId]);
  accountId = account.id;
});

after(async () => {
  await pool.query("DELETE FROM recurring_expense_history WHERE recurring_expense_id IN (SELECT id FROM recurring_expenses WHERE merchant_key IN ('netflix com', 'acme payroll'))");
  await pool.query("DELETE FROM recurring_expenses WHERE merchant_key IN ('netflix com', 'acme payroll')");
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'tx-recurring-db-%'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-recurring-db'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-recurring-db'");
  await pool.end();
});

async function insertTx(id, amount, date, merchantName) {
  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, source)
    VALUES ($1, $2, $3, $4, $5, $5, false, 'test')
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      date = EXCLUDED.date,
      merchant_name = EXCLUDED.merchant_name,
      name = EXCLUDED.name,
      updated_at = now()
  `, [id, accountId, amount, date, merchantName]);
}

describe('recurring-detector DB integration', () => {
  it('persists recurring rows idempotently on repeated runs', async () => {
    await insertTx('tx-recurring-db-1', 15.49, '2026-01-05', 'NETFLIX.COM/111111');
    await insertTx('tx-recurring-db-2', 15.49, '2026-02-05', 'NETFLIX.COM/222222');
    await insertTx('tx-recurring-db-3', 15.49, '2026-03-05', 'NETFLIX.COM/333333');

    const first = await detectRecurringCashflows({
      asOfDate: '2026-03-10',
      incremental: false,
      lookbackMonths: 18
    });
    assert.equal(first.candidates.length, 1);

    const second = await detectRecurringCashflows({
      asOfDate: '2026-03-10',
      incremental: false,
      lookbackMonths: 18
    });
    assert.equal(second.candidates.length, 1);

    const { rows: recurringRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM recurring_expenses WHERE merchant_key = 'netflix com'`
    );
    const { rows: historyRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM recurring_expense_history reh
       JOIN recurring_expenses re ON re.id = reh.recurring_expense_id
       WHERE re.merchant_key = 'netflix com'`
    );

    assert.equal(recurringRows[0].count, 1);
    assert.equal(historyRows[0].count, 1);
  });

  it('supports incremental runs that skip unchanged merchant groups', async () => {
    await insertTx('tx-recurring-db-4', -2500.00, '2026-03-14', 'ACME PAYROLL');
    await insertTx('tx-recurring-db-5', -2500.00, '2026-03-28', 'ACME PAYROLL');
    await insertTx('tx-recurring-db-6', -2500.00, '2026-04-11', 'ACME PAYROLL');

    const baseline = new Date().toISOString();
    const result = await detectRecurringCashflows({
      asOfDate: '2026-04-12',
      lastDetectionAt: baseline,
      incremental: true,
      lookbackMonths: 18
    });

    assert.equal(result.incremental, true);
    assert.equal(result.candidates.length, 0);

    await insertTx('tx-recurring-db-7', -2500.00, '2026-04-25', 'ACME PAYROLL');
    const changed = await detectRecurringCashflows({
      asOfDate: '2026-04-26',
      lastDetectionAt: baseline,
      incremental: true,
      lookbackMonths: 18
    });

    assert.equal(changed.incremental, true);
    assert.equal(changed.candidates.length, 1);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM recurring_expenses WHERE merchant_key = 'acme payroll' AND cashflow_type = 'income'`
    );
    assert.equal(rows[0].count, 1);
  });

  it('treats null schedule anchors as the same identity during upsert', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = {
        merchant_key: 'manual service',
        merchant_name: 'Manual Service',
        cashflow_type: 'expense',
        frequency: 'unknown',
        confidence: 'low',
        status: 'active',
        latest_account_id: accountId,
        latest_amount: 45.00,
        prior_amount: null,
        price_change_pct: null,
        price_change_direction: null,
        price_change_date: null,
        first_seen_date: '2026-02-01',
        last_seen_date: '2026-03-01',
        expected_next_date: null,
        interval_days: null,
        tolerance_days: 3,
        schedule_anchor_type: null,
        schedule_anchor_value: null,
        source_txn_count: 2,
        latest_transaction_id: null
      };

      await upsertRecurringCandidate(client, candidate, '2026-03-02');
      await upsertRecurringCandidate(client, candidate, '2026-03-02');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM recurring_expenses
      WHERE merchant_key = 'manual service'
        AND schedule_anchor_type IS NULL
        AND schedule_anchor_value IS NULL
    `);
    assert.equal(rows[0].count, 1);

    await pool.query("DELETE FROM recurring_expenses WHERE merchant_key = 'manual service'");
  });

  it('does not duplicate when the deposit day drifts (weekday-anchored schedule)', async () => {
    const base = {
      merchant_key: 'drift benefits',
      merchant_name: 'Drift Benefits',
      cashflow_type: 'income',
      frequency: 'monthly',
      confidence: 'high',
      status: 'active',
      latest_account_id: accountId,
      latest_amount: 4626.00,
      prior_amount: 4626.00,
      price_change_pct: 0,
      price_change_direction: null,
      price_change_date: null,
      first_seen_date: '2026-04-15',
      last_seen_date: '2026-05-20',
      expected_next_date: '2026-06-20',
      interval_days: 30,
      tolerance_days: 3,
      schedule_anchor_type: 'day_of_month',
      schedule_anchor_value: '20', // May deposit landed on the 20th
      source_txn_count: 2,
      latest_transaction_id: null
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertRecurringCandidate(client, base, '2026-05-21');
      // Next month the deposit lands on the 17th -> anchor day changes 20 -> 17.
      await upsertRecurringCandidate(client, {
        ...base,
        last_seen_date: '2026-06-17',
        expected_next_date: '2026-07-17',
        schedule_anchor_value: '17',
        source_txn_count: 3
      }, '2026-06-18');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS count, MAX(schedule_anchor_value) AS anchor, MAX(last_seen_date) AS last_seen
      FROM recurring_expenses
      WHERE merchant_key = 'drift benefits' AND cashflow_type = 'income' AND frequency = 'monthly'
    `);
    assert.equal(rows[0].count, 1); // one row, not two
    assert.equal(rows[0].anchor, '17'); // anchor refreshed to the latest deposit day

    await pool.query("DELETE FROM recurring_expenses WHERE merchant_key = 'drift benefits'");
  });
});
