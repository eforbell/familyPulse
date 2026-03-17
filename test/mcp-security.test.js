'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tool handlers under test
const { getAccountBalances } = require('../mcp/tools/accounts');
const { getTransactions } = require('../mcp/tools/transactions');
const { getBudgetStatus } = require('../mcp/tools/budget');
const { getAnomalies } = require('../mcp/tools/anomalies');
const { getFinancialSnapshot } = require('../mcp/tools/snapshot');

// Known forbidden field names that must never appear in tool responses
const FORBIDDEN_FIELDS = [
  'access_token', 'accesstoken', 'plaid_secret', 'api_key',
  'passphrase_hash', 'item_id', 'plaid_account_id', 'plaid_transaction_id'
];

// Secret patterns that must never appear in serialized output
const SECRET_PATTERNS = [
  /access-sandbox-/i,
  /access-production-/i,
  /access-development-/i,
  /sk-[a-zA-Z0-9_-]{20,}/,
  /plaid_secret_/i
];

/**
 * Deep-check an object for forbidden fields and secret patterns.
 */
function assertClean(data, label) {
  const json = JSON.stringify(data);

  // Check for secret patterns in serialized output
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(!pattern.test(json), `${label}: found secret pattern ${pattern} in output`);
  }

  // Deep check for forbidden field names
  function checkFields(obj, path = '') {
    if (obj === null || obj === undefined) return;
    if (typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach((item, i) => checkFields(item, `${path}[${i}]`));
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      assert.ok(
        !FORBIDDEN_FIELDS.includes(lower),
        `${label}: forbidden field "${key}" at ${path}.${key}`
      );
      checkFields(value, `${path}.${key}`);
    }
  }

  checkFields(data);
}

// Test fixture prefix for isolation
const PREFIX = 'mcp-sec-';
let testItemId;

before(async () => {
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
    ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
  `);

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('access-sandbox-fake-token-for-mcp-security-test', 'test-item-mcp-sec', 'ins_mcp_sec', 'MCP Security Bank', 'good')
    ON CONFLICT (item_id) DO UPDATE SET
      status = 'good', access_token = 'access-sandbox-fake-token-for-mcp-security-test'
    RETURNING id
  `);
  testItemId = item.id;

  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner)
    VALUES ($2, $1, 'Security Check Acct', 'depository', 'checking', '8001', 3000.00, 2900.00, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      current_balance = 3000.00, available_balance = 2900.00
  `, [testItemId, `${PREFIX}checking`]);
});

after(async () => {
  await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM accounts WHERE plaid_account_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM items WHERE item_id = 'test-item-mcp-sec'`);
  await pool.end();
});

describe('MCP security: no secrets in tool responses', () => {
  it('get_account_balances contains no secrets', async () => {
    const result = await getAccountBalances();
    assertClean(result, 'get_account_balances');
  });

  it('get_transactions contains no secrets', async () => {
    const result = await getTransactions({ limit: 10 });
    assertClean(result, 'get_transactions');
  });

  it('get_transactions summary mode contains no secrets', async () => {
    const result = await getTransactions({ summary_mode: true });
    assertClean(result, 'get_transactions (summary)');
  });

  it('get_budget_status contains no secrets', async () => {
    const result = await getBudgetStatus();
    assertClean(result, 'get_budget_status');
  });

  it('get_anomalies contains no secrets', async () => {
    const result = await getAnomalies();
    assertClean(result, 'get_anomalies');
  });

  it('get_financial_snapshot contains no secrets', async () => {
    const result = await getFinancialSnapshot();
    assertClean(result, 'get_financial_snapshot');
  });
});

describe('MCP security: responses contain only user-facing data', () => {
  it('account balances use display names, not raw IDs', async () => {
    const result = await getAccountBalances();
    const json = JSON.stringify(result);

    // Should not contain plaid_account_id values
    assert.ok(!json.includes(PREFIX), 'should not contain plaid_account_id prefix');
    assert.ok(!json.includes('test-item-mcp'), 'should not contain item_id');
  });

  it('transactions use merchant names, not internal IDs', async () => {
    const result = await getTransactions({ limit: 5 });
    if (result.transactions.length > 0) {
      const tx = result.transactions[0];
      // Should have user-facing fields only
      const allowedKeys = ['date', 'merchant', 'amount', 'pending', 'category', 'account'];
      for (const key of Object.keys(tx)) {
        assert.ok(allowedKeys.includes(key), `unexpected field "${key}" in transaction`);
      }
    }
  });
});
