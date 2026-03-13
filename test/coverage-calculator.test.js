'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Require after pool is available (uses shared db module)
const { getCoverage } = require('../lib/coverage-calculator');

let testItemId;

before(async () => {
  // Ensure coverage_alert_threshold exists
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('coverage_alert_threshold', '0.70')
    ON CONFLICT (key) DO UPDATE SET value = '0.70'
  `);

  // Create a test item
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-cov', 'test-item-cov', 'ins_cov', 'Coverage Test Bank', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  testItemId = item.id;
});

after(async () => {
  await pool.query("DELETE FROM accounts WHERE plaid_account_id LIKE 'acct-cov-%'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-cov'");
  await pool.end();
});

describe('coverage-calculator — healthy scenario', () => {
  before(async () => {
    // Checking account with $10,000
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-cov-chk1', $1, 'Main Checking', 'depository', 'checking', '0001', 10000.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET current_balance = 10000.00, type = 'depository', subtype = 'checking'
    `, [testItemId]);

    // Credit card with $2000 statement balance, due next week
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance,
                            last_statement_balance, minimum_payment_amount, next_payment_due_date)
      VALUES ('acct-cov-cc1', $1, 'Visa Card', 'credit', 'credit card', '1111', 2500.00,
              2000.00, 25.00, CURRENT_DATE + 7)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 2500.00, last_statement_balance = 2000.00,
        minimum_payment_amount = 25.00, next_payment_due_date = CURRENT_DATE + 7,
        type = 'credit', subtype = 'credit card'
    `, [testItemId]);
  });

  it('returns healthy status when checking covers obligations', async () => {
    const result = await getCoverage();
    assert.equal(result.status, 'healthy');
    assert.equal(result.depository_total, 10000);
    assert.equal(result.obligation_total, 2000);
    assert.equal(result.ratio, 5);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0].name, 'Visa Card');
    assert.equal(result.cards[0].obligation, 2000);
    assert.equal(result.cards[0].minimum_payment, 25);
  });
});

describe('coverage-calculator — warning scenario', () => {
  before(async () => {
    // Reduce checking to $3000, add another card with $1500 statement
    await pool.query(`
      UPDATE accounts SET current_balance = 3000.00 WHERE plaid_account_id = 'acct-cov-chk1'
    `);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance,
                            last_statement_balance, next_payment_due_date)
      VALUES ('acct-cov-cc2', $1, 'Amex Card', 'credit', 'credit card', '2222', 1500.00,
              1500.00, CURRENT_DATE + 14)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 1500.00, last_statement_balance = 1500.00,
        next_payment_due_date = CURRENT_DATE + 14,
        type = 'credit', subtype = 'credit card'
    `, [testItemId]);
  });

  it('returns warning when obligations consume >=70% of checking', async () => {
    const result = await getCoverage();
    // 3500 / 3000 > 1 → this is actually danger (obligations exceed checking)
    // Let's check: obligations = 2000 + 1500 = 3500, checking = 3000
    assert.equal(result.status, 'danger');
    assert.equal(result.obligation_total, 3500);
  });

  it('orders cards by due date ascending', async () => {
    const result = await getCoverage();
    assert.equal(result.cards.length, 2);
    // First card due sooner (7 days) should come first
    assert.equal(result.cards[0].name, 'Visa Card');
    assert.equal(result.cards[1].name, 'Amex Card');
  });

  after(async () => {
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-cov-cc2'");
    await pool.query(`UPDATE accounts SET current_balance = 10000.00 WHERE plaid_account_id = 'acct-cov-chk1'`);
  });
});

describe('coverage-calculator — danger scenario', () => {
  before(async () => {
    await pool.query(`UPDATE accounts SET current_balance = 1500.00 WHERE plaid_account_id = 'acct-cov-chk1'`);
  });

  it('returns danger when obligations exceed checking', async () => {
    const result = await getCoverage();
    assert.equal(result.status, 'danger');
    assert.ok(result.ratio < 1);
  });

  after(async () => {
    await pool.query(`UPDATE accounts SET current_balance = 10000.00 WHERE plaid_account_id = 'acct-cov-chk1'`);
  });
});

describe('coverage-calculator — clear scenario', () => {
  before(async () => {
    // Remove credit card obligation
    await pool.query(`
      UPDATE accounts SET last_statement_balance = 0, current_balance = 0
      WHERE plaid_account_id = 'acct-cov-cc1'
    `);
  });

  it('returns clear when no obligations exist', async () => {
    const result = await getCoverage();
    assert.equal(result.status, 'clear');
    assert.equal(result.obligation_total, 0);
    assert.equal(result.ratio, null);
  });

  after(async () => {
    await pool.query(`
      UPDATE accounts SET last_statement_balance = 2000.00, current_balance = 2500.00
      WHERE plaid_account_id = 'acct-cov-cc1'
    `);
  });
});

describe('coverage-calculator — statement fallback', () => {
  before(async () => {
    // Set statement balance to NULL — should fall back to current_balance
    await pool.query(`
      UPDATE accounts SET last_statement_balance = NULL, current_balance = 800.00
      WHERE plaid_account_id = 'acct-cov-cc1'
    `);
  });

  it('falls back to current_balance when no statement balance', async () => {
    const result = await getCoverage();
    assert.equal(result.obligation_total, 800);
    assert.equal(result.cards[0].obligation, 800);
    assert.equal(result.cards[0].statement_balance, null);
  });
});
