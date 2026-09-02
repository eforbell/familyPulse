'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tool handlers under test
const { getAccountBalances } = require('../mcp/tools/accounts');
const { getTransactions } = require('../mcp/tools/transactions');
const { getBudgetStatus, getCashFlowSummary } = require('../mcp/tools/budget');
const { getAnomalies } = require('../mcp/tools/anomalies');

// Test fixture prefix for isolation
const PREFIX = 'mcp-test-';
let testItemId;
let checkingAccountId;
let diningCategoryId;
let healthcareCategoryId;

before(async () => {
  // Ensure balance_basis config exists
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
    ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
  `);

  // Create test item
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-mcp', 'test-item-mcp', 'ins_mcp', 'MCP Test Bank', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  testItemId = item.id;

  // Create test accounts
  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner)
    VALUES ($2, $1, 'MCP Checking', 'depository', 'checking', '9001', 5000.00, 4800.00, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      current_balance = 5000.00, available_balance = 4800.00,
      type = 'depository', subtype = 'checking', owner = 'Eric'
  `, [testItemId, `${PREFIX}checking`]);

  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
    VALUES ($2, $1, 'MCP Credit Card', 'credit', 'credit card', '9002', -800.00, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      current_balance = -800.00, type = 'credit', subtype = 'credit card', owner = 'Eric'
  `, [testItemId, `${PREFIX}credit`]);

  // Get the checking account id for transactions
  const { rows: [checkingAcct] } = await pool.query(
    `SELECT id FROM accounts WHERE plaid_account_id = $1`, [`${PREFIX}checking`]
  );
  checkingAccountId = checkingAcct.id;

  // Ensure a test category exists
  await pool.query(`
    INSERT INTO categories (name, icon, color, budget_amount, is_transfer_class, is_income)
    VALUES ('MCP Test Dining', '🍔', '#ff0000', 200.00, false, false)
    ON CONFLICT (name) DO UPDATE SET budget_amount = 200.00, is_transfer_class = false, is_income = false
  `);

  const { rows: [cat] } = await pool.query(`SELECT id FROM categories WHERE name = 'MCP Test Dining'`);
  diningCategoryId = cat.id;

  const { rows: [healthcareCat] } = await pool.query(`
    INSERT INTO categories (name, icon, color, budget_amount, is_transfer_class, is_income)
    VALUES ('MCP Test Healthcare', '🩺', '#00aaff', 200.00, false, false)
    ON CONFLICT (name) DO UPDATE SET budget_amount = 200.00, is_transfer_class = false, is_income = false
    RETURNING id
  `);
  healthcareCategoryId = healthcareCat.id;

  // Create test transactions
  const txDate = new Date();
  txDate.setDate(txDate.getDate() - 2);
  const dateStr = txDate.toISOString().split('T')[0];

  for (let i = 0; i < 3; i++) {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, merchant_name, category_id, is_transfer, is_hidden, pending)
      VALUES ($1, $2, $3, $4, $5, $6, $7, false, false, false)
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET
        amount = $3, date = $4, category_id = $7
    `, [
      `${PREFIX}tx-${i}`, checkingAcct.id, 25.50 + i, dateStr,
      `MCP Test Merchant ${i}`, `MCP Test Merchant ${i}`, cat.id
    ]);
  }

  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, merchant_name, category_id, is_transfer, is_hidden, pending, transfer_type)
    VALUES ($1, $2, $3, $4, $5, $6, NULL, true, false, false, 'cc_payment')
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      amount = $3, date = $4, is_transfer = true, category_id = NULL, transfer_type = 'cc_payment'
  `, [
    `${PREFIX}uncat-transfer`, checkingAcct.id, 88.25, dateStr,
    'MCP Uncategorized Transfer', 'MCP Uncategorized Transfer'
  ]);

  const splitFixtures = await pool.connect();
  try {
    await splitFixtures.query('BEGIN');
    const { rows: [splitTx] } = await splitFixtures.query(`
      INSERT INTO transactions
        (plaid_transaction_id, account_id, amount, date, name, merchant_name, category_id, is_transfer, is_hidden, pending)
      VALUES ($1, $2, 100.00, $3, 'MCP Split Merchant', 'MCP Split Merchant', NULL, false, false, false)
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = 100.00, date = EXCLUDED.date
      RETURNING id
    `, [`${PREFIX}split`, checkingAccountId, dateStr]);
    await splitFixtures.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [splitTx.id]);
    await splitFixtures.query(`
      INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
      VALUES ($1, $2, 60.00, 1), ($1, $3, 40.00, 2)
    `, [splitTx.id, diningCategoryId, healthcareCategoryId]);

    const { rows: [uncategorizedSplitTx] } = await splitFixtures.query(`
      INSERT INTO transactions
        (plaid_transaction_id, account_id, amount, date, name, merchant_name, category_id, is_transfer, is_hidden, pending)
      VALUES ($1, $2, 80.00, $3, 'MCP Uncategorized Split', 'MCP Uncategorized Split', NULL, false, false, false)
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = 80.00, date = EXCLUDED.date
      RETURNING id
    `, [`${PREFIX}uncat-split`, checkingAccountId, dateStr]);
    await splitFixtures.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [uncategorizedSplitTx.id]);
    await splitFixtures.query(`
      INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
      VALUES ($1, NULL, 30.00, 1), ($1, $2, 50.00, 2)
    `, [uncategorizedSplitTx.id, diningCategoryId]);
    await splitFixtures.query('COMMIT');
  } catch (err) {
    await splitFixtures.query('ROLLBACK');
    throw err;
  } finally {
    splitFixtures.release();
  }
});

after(async () => {
  await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM accounts WHERE plaid_account_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM items WHERE item_id = 'test-item-mcp'`);
  await pool.query(`DELETE FROM categories WHERE name IN ('MCP Test Dining', 'MCP Test Healthcare')`);
  await pool.end();
});

// ── get_account_balances ──────────────────────────────────────

describe('MCP: get_account_balances', () => {
  it('returns accounts grouped by owner', async () => {
    const result = await getAccountBalances();
    assert.ok(result.groups, 'should have groups');
    assert.ok(result.totals, 'should have totals');
    assert.ok(typeof result.account_count === 'number');

    // Eric's group should exist with our test accounts
    const ericAccounts = result.groups['Eric'];
    assert.ok(ericAccounts, 'should have Eric group');
    const checking = ericAccounts.find(a => a.name === 'MCP Checking');
    assert.ok(checking, 'should find MCP Checking');
    assert.equal(checking.type, 'depository');
    assert.equal(checking.balance, 4800); // available_preferred
    assert.equal(checking.balance_kind, 'available');
  });

  it('filters by member_name', async () => {
    const result = await getAccountBalances({ member_name: 'Eric' });
    const owners = Object.keys(result.groups);
    assert.ok(owners.every(o => o.toLowerCase().includes('eric') || o === 'Household'),
      'should only contain Eric accounts');
  });
});

// ── get_transactions ──────────────────────────────────────────

describe('MCP: get_transactions', () => {
  it('returns transactions matching search', async () => {
    const result = await getTransactions({ search: 'MCP Test Merchant' });
    assert.ok(result.transactions.length >= 3, 'should find test transactions');
    assert.ok(result.total >= 3);

    const tx = result.transactions[0];
    assert.ok(tx.date, 'should have date');
    assert.ok(tx.merchant, 'should have merchant');
    assert.ok(typeof tx.amount === 'number', 'amount should be number');
    assert.ok(tx.category, 'should have category');
    assert.ok(tx.account, 'should have account name');
  });

  it('returns summary mode aggregation', async () => {
    const result = await getTransactions({ search: 'MCP Test Merchant', summary_mode: true });
    assert.ok(result.summary, 'should have summary array');
    assert.ok(typeof result.total_spending === 'number');
    assert.ok(typeof result.net === 'number');

    const diningCategory = result.summary.find(s => s.category === 'MCP Test Dining');
    assert.ok(diningCategory, 'should find MCP Test Dining in summary');
    assert.ok(diningCategory.transaction_count >= 3);
  });

  it('respects pagination', async () => {
    const result = await getTransactions({ search: 'MCP Test Merchant', limit: 2, offset: 0 });
    assert.ok(result.transactions.length <= 2, 'should respect limit');
    assert.equal(result.limit, 2);
    assert.equal(result.offset, 0);
  });

  it('caps limit at 200', async () => {
    const result = await getTransactions({ search: 'MCP Test Merchant', limit: 999 });
    assert.equal(result.limit, 200);
  });

  it('includes uncategorized transfer rows when explicitly querying Uncategorized', async () => {
    const result = await getTransactions({ category: 'Uncategorized' });
    assert.ok(result.transactions.some(t => t.merchant === 'MCP Uncategorized Transfer'));
  });

  it('uses matching allocation amounts for category-filtered detail totals', async () => {
    const filtered = await getTransactions({
      category: 'MCP Test Dining',
      search: 'MCP Split Merchant'
    });
    assert.equal(filtered.total, 1, 'a split transaction should count as one parent transaction');
    assert.equal(filtered.sum, 60, 'the filtered total should use only the Dining allocation');
    assert.equal(filtered.transactions[0].amount, 100, 'detail rows retain the parent transaction amount');

    const unfiltered = await getTransactions({ search: 'MCP Split Merchant' });
    assert.equal(unfiltered.total, 1);
    assert.equal(unfiltered.sum, 100, 'unfiltered totals should retain the parent transaction amount');
  });

  it('uses only the uncategorized allocation in Uncategorized detail totals', async () => {
    const result = await getTransactions({
      category: 'Uncategorized',
      search: 'MCP Uncategorized Split'
    });
    assert.equal(result.total, 1);
    assert.equal(result.sum, 30);
    assert.equal(result.transactions[0].amount, 80);
  });
});

// ── get_budget_status ─────────────────────────────────────────

describe('MCP: get_budget_status', () => {
  it('returns budget summary for current month', async () => {
    const result = await getBudgetStatus();
    assert.ok(result.period, 'should have period');
    assert.ok(typeof result.income === 'number');
    assert.ok(typeof result.spending === 'number');
    assert.ok(typeof result.net_cash_flow === 'number');
    assert.ok(Array.isArray(result.categories));
    assert.ok(result.uncategorized, 'should have uncategorized');
  });

  it('accepts explicit period', async () => {
    const result = await getBudgetStatus({ period: '2026-01' });
    assert.equal(result.period, '2026-01');
  });
});

// ── get_cash_flow_summary ─────────────────────────────────────

describe('MCP: get_cash_flow_summary', () => {
  it('returns multi-month cash flow with defaults', async () => {
    const result = await getCashFlowSummary();
    assert.ok(result.start_period);
    assert.ok(result.end_period);
    assert.ok(Array.isArray(result.months));
    assert.ok(result.months.length >= 1);
    assert.ok(result.totals);
    assert.ok(result.averages);

    const month = result.months[0];
    assert.ok(typeof month.income === 'number');
    assert.ok(typeof month.spending === 'number');
    assert.ok(typeof month.net_cash_flow === 'number');
  });

  it('accepts explicit period range', async () => {
    const result = await getCashFlowSummary({ start_period: '2026-01', end_period: '2026-03' });
    assert.equal(result.start_period, '2026-01');
    assert.equal(result.end_period, '2026-03');
    assert.equal(result.months.length, 3);
  });

  it('aggregates net cash flow from the authoritative monthly values', async () => {
    const result = await getCashFlowSummary({ start_period: '2026-01', end_period: '2026-03' });
    const monthlyNet = result.months.reduce((sum, month) => sum + month.net_cash_flow, 0);
    assert.equal(result.totals.net_cash_flow, Math.round(monthlyNet * 100) / 100);
    assert.equal(
      result.averages.net_cash_flow,
      Math.round((monthlyNet / result.months.length) * 100) / 100
    );
  });

  it('preserves an explicit start_period when end_period is omitted', async () => {
    const explicitStart = '2026-01';
    const now = new Date();
    const expectedEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await getCashFlowSummary({ start_period: explicitStart });

    assert.equal(result.start_period, explicitStart);
    assert.equal(result.end_period, expectedEnd);
  });

  it('preserves an explicit end_period when start_period is omitted', async () => {
    const explicitEnd = '2026-03';
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const expectedStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;

    const result = await getCashFlowSummary({ end_period: explicitEnd });

    assert.equal(result.start_period, expectedStart);
    assert.equal(result.end_period, explicitEnd);
  });
});

// ── get_anomalies ─────────────────────────────────────────────

describe('MCP: get_anomalies', () => {
  it('returns anomalies structure for current month', async () => {
    const result = await getAnomalies();
    assert.ok(result.period);
    assert.ok(typeof result.total === 'number');
    assert.ok(Array.isArray(result.anomalies));
  });

  it('accepts explicit period and include_acknowledged', async () => {
    const result = await getAnomalies({ period: '2026-01', include_acknowledged: true });
    assert.equal(result.period, '2026-01');
    assert.ok(Array.isArray(result.anomalies));
  });
});
