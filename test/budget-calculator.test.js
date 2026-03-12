'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../lib/db');

// Use an isolated far-future period to avoid collisions with real household data.
const TEST_PERIOD = '2099-06';
const PRIOR_PERIOD = '2099-05';
const TWO_AGO = '2099-04';
const THREE_AGO = '2099-03';

describe('budget-calculator', () => {
  let testCatId, incomeCatId, transferCatId, uncatId, accountId;

  before(async () => {
    // Ensure schema is ready
    await pool.query(`
      CREATE TABLE IF NOT EXISTS budget_snapshots (
        id SERIAL PRIMARY KEY,
        category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        budgeted NUMERIC(10,2) NOT NULL DEFAULT 0,
        actual_spent NUMERIC(10,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(category_id, period)
      )
    `);

    // Get or create test categories
    const { rows: [cat] } = await pool.query(
      `INSERT INTO categories (name, color, budget_amount, is_income, is_transfer_class, icon)
       VALUES ('TestBudgetCat', '#22c55e', 500, false, false, '🧪')
       ON CONFLICT (name) DO UPDATE SET budget_amount = 500
       RETURNING id`
    );
    testCatId = cat.id;

    const { rows: [inc] } = await pool.query(
      `SELECT id FROM categories WHERE name = 'Income' LIMIT 1`
    );
    incomeCatId = inc?.id;
    if (!incomeCatId) {
      const { rows: [newInc] } = await pool.query(
        `INSERT INTO categories (name, color, is_income, is_transfer_class, icon)
         VALUES ('Income', '#10b981', true, false, '💰')
         ON CONFLICT (name) DO UPDATE SET is_income = true
         RETURNING id`
      );
      incomeCatId = newInc.id;
    }

    const { rows: [xfer] } = await pool.query(
      `SELECT id FROM categories WHERE name = 'Transfer' LIMIT 1`
    );
    transferCatId = xfer?.id;
    if (!transferCatId) {
      const { rows: [newXfer] } = await pool.query(
        `INSERT INTO categories (name, color, is_income, is_transfer_class, icon)
         VALUES ('Transfer', '#9ca3af', false, true, '🔄')
         ON CONFLICT (name) DO UPDATE SET is_transfer_class = true
         RETURNING id`
      );
      transferCatId = newXfer.id;
    }

    const { rows: [unc] } = await pool.query(
      `SELECT id FROM categories WHERE name = 'Uncategorized' LIMIT 1`
    );
    uncatId = unc?.id;

    // Get or create a test account
    const { rows: accounts } = await pool.query('SELECT id FROM accounts LIMIT 1');
    if (accounts.length > 0) {
      accountId = accounts[0].id;
    } else {
      // Create a minimal item + account for testing
      const { rows: [item] } = await pool.query(
        `INSERT INTO items (access_token, item_id, institution_name, status)
         VALUES ('test-token', 'test-item-budget', 'Test Bank', 'good')
         ON CONFLICT (item_id) DO UPDATE SET institution_name = 'Test Bank'
         RETURNING id`
      );
      const { rows: [acct] } = await pool.query(
        `INSERT INTO accounts (plaid_account_id, item_id, name, type, mask)
         VALUES ('test-acct-budget', $1, 'Test Checking', 'depository', '1234')
         ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Test Checking'
         RETURNING id`,
        [item.id]
      );
      accountId = acct.id;
    }

    // Clean up test transactions
    await pool.query(
      `DELETE FROM transactions WHERE plaid_transaction_id LIKE 'test-budget-%'`
    );

    // Insert test spending transactions (positive amounts = debits in Plaid)
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES
        ('test-budget-1', $1, 120.00, $3::date, 'Grocery Store', $2, false),
        ('test-budget-2', $1, 80.00,  $4::date, 'Gas Station', $2, false),
        ('test-budget-3', $1, 50.00,  $5::date, 'Test Merchant', $2, false)
    `, [accountId, testCatId, `${TEST_PERIOD}-05`, `${TEST_PERIOD}-15`, `${TEST_PERIOD}-20`]);

    // Insert income (negative amounts in Plaid = credits)
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-budget-income-1', $1, -5000.00, $3::date, 'Employer', $2, false)
    `, [accountId, incomeCatId, `${TEST_PERIOD}-01`]);

    // Insert transfer (should be excluded)
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-budget-xfer-1', $1, 1000.00, $3::date, 'Transfer Out', $2, true)
    `, [accountId, transferCatId, `${TEST_PERIOD}-10`]);

    // Insert prior month spending for rolling avg
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES
        ('test-budget-prior-1', $1, 200.00, $3::date, 'Prior Month', $2, false),
        ('test-budget-prior-2', $1, 150.00, $4::date, 'Two Months Ago', $2, false),
        ('test-budget-prior-3', $1, 300.00, $5::date, 'Three Months Ago', $2, false)
    `, [accountId, testCatId, `${PRIOR_PERIOD}-10`, `${TWO_AGO}-10`, `${THREE_AGO}-10`]);

    // Insert prior month income
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-budget-income-prior', $1, -4500.00, $3::date, 'Employer', $2, false)
    `, [accountId, incomeCatId, `${PRIOR_PERIOD}-01`]);

    // Insert uncategorized
    if (uncatId) {
      await pool.query(`
        INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
        VALUES ('test-budget-uncat-1', $1, 25.00, $3::date, 'Random Store', $2, false)
      `, [accountId, uncatId, `${TEST_PERIOD}-18`]);
    }
  });

  after(async () => {
    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id LIKE 'test-budget-%'`);
    await pool.query(`DELETE FROM budget_snapshots WHERE category_id = $1`, [testCatId]);
    await pool.query(`DELETE FROM categories WHERE name = 'TestBudgetCat'`);
    // Don't drop test items/accounts if they existed before
  });

  it('getMonthlyBudgetSummary returns correct spending', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    assert.equal(summary.period, TEST_PERIOD);
    assert.ok(Array.isArray(summary.categories));

    const testCat = summary.categories.find(c => c.id === testCatId);
    assert.ok(testCat, 'TestBudgetCat should be in categories');
    assert.equal(testCat.spent, 250); // 120 + 80 + 50
    assert.equal(testCat.budgeted, 500);
    assert.equal(testCat.remaining, 250);
    assert.equal(testCat.pct_used, 50);
    assert.equal(testCat.status, 'green'); // 50% < 70%
  });

  it('excludes transfers from spending', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    // Transfer category should not appear in categories list
    const xferCat = summary.categories.find(c => c.id === transferCatId);
    assert.equal(xferCat, undefined, 'Transfer categories should be excluded');
  });

  it('calculates income correctly', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    assert.equal(summary.income.current, 5000);
    assert.equal(summary.income.prior, 4500);
  });

  it('calculates net cash flow', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    // Net = income - total spending (across ALL categories, not just test)
    assert.equal(typeof summary.net_cash_flow.current, 'number');
    assert.equal(typeof summary.net_cash_flow.prior, 'number');
  });

  it('reports uncategorized spending', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    if (uncatId) {
      assert.ok(summary.uncategorized.spent >= 25);
      assert.ok(summary.uncategorized.count >= 1);
    }
  });

  it('calculates rolling 3-month average', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);

    const testCat = summary.categories.find(c => c.id === testCatId);
    // Prior 3 months: 200 + 150 + 300 = 650, across 3 months = ~216.67
    assert.ok(testCat.avg_3mo > 0, 'Should have a rolling average');
  });

  it('status thresholds: green < 70%, yellow 70-99%, red >= 100%', async () => {
    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');

    // TestBudgetCat: 250/500 = 50% → green
    const summary = await getMonthlyBudgetSummary(TEST_PERIOD);
    const testCat = summary.categories.find(c => c.id === testCatId);
    assert.equal(testCat.status, 'green');

    // Temporarily change budget to make it yellow (70-99%)
    await pool.query('UPDATE categories SET budget_amount = 300 WHERE id = $1', [testCatId]);
    const summary2 = await getMonthlyBudgetSummary(TEST_PERIOD);
    const cat2 = summary2.categories.find(c => c.id === testCatId);
    assert.equal(cat2.status, 'yellow'); // 250/300 = 83%

    // Make it red (>=100%)
    await pool.query('UPDATE categories SET budget_amount = 200 WHERE id = $1', [testCatId]);
    const summary3 = await getMonthlyBudgetSummary(TEST_PERIOD);
    const cat3 = summary3.categories.find(c => c.id === testCatId);
    assert.equal(cat3.status, 'red'); // 250/200 = 125%

    // Restore
    await pool.query('UPDATE categories SET budget_amount = 500 WHERE id = $1', [testCatId]);
  });
});

describe('snapshot-generator', () => {
  it('generateSnapshot upserts correctly', async () => {
    const { generateSnapshot } = require('../lib/snapshot-generator');
    const result = await generateSnapshot(TEST_PERIOD);

    assert.equal(result.period, TEST_PERIOD);
    assert.ok(result.rows_upserted > 0);

    // Run again — should be idempotent
    const result2 = await generateSnapshot(TEST_PERIOD);
    assert.equal(result2.period, TEST_PERIOD);
  });

  after(async () => {
    await pool.query(`DELETE FROM budget_snapshots WHERE period = $1`, [TEST_PERIOD]);
  });
});
