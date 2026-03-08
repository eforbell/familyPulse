'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// We need a fresh set of test data for transfer detection
let itemId, acctId1, acctId2;

before(async () => {
  // Create test item + two accounts
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-xfer', 'test-item-xfer', 'ins_test', 'Test Bank Xfer', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  itemId = item.id;

  const { rows: [a1] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
    VALUES ('acct-xfer-checking', $1, 'Checking', 'depository', 'checking', '1111', 5000)
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Checking'
    RETURNING id
  `, [itemId]);
  acctId1 = a1.id;

  const { rows: [a2] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
    VALUES ('acct-xfer-savings', $1, 'Savings', 'depository', 'savings', '2222', 10000)
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Savings'
    RETURNING id
  `, [itemId]);
  acctId2 = a2.id;
});

after(async () => {
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id LIKE 'acct-xfer-%'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-xfer'");
  await pool.end();
});

async function insertTx(id, accountId, amount, date, name, merchantName) {
  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, merchant_name, pending, is_transfer, source)
    VALUES ($1, $2, $3, $4, $5, $6, false, false, 'test')
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL
  `, [id, accountId, amount, date, name, merchantName]);
}

describe('transfer detection', () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  describe('inter-account transfers', () => {
    before(async () => {
      // Reset transfer flags
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");

      // Matching pair: -500 from checking, +500 to savings, same day
      await insertTx('tx-xfer-out-1', acctId1, -500.00, today, 'Transfer to Savings', null);
      await insertTx('tx-xfer-in-1', acctId2, 500.00, today, 'Transfer from Checking', null);
    });

    it('detects matching inter-account transfers', async () => {
      const { detectTransfers } = require('../lib/transfer-detection');
      const result = await detectTransfers(7);

      assert.ok(result.inter_account >= 2, `Expected >=2 inter-account, got ${result.inter_account}`);

      // Both transactions should be flagged
      const { rows } = await pool.query(
        "SELECT is_transfer, transfer_type FROM transactions WHERE plaid_transaction_id IN ('tx-xfer-out-1', 'tx-xfer-in-1') ORDER BY plaid_transaction_id"
      );
      for (const row of rows) {
        assert.equal(row.is_transfer, true);
        assert.equal(row.transfer_type, 'inter_account');
      }
    });
  });

  describe('CC payments', () => {
    before(async () => {
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
      await insertTx('tx-xfer-cc-1', acctId1, -1500.00, today, 'PAYMENT THANK YOU', null);
    });

    it('detects credit card payment patterns', async () => {
      const { detectTransfers } = require('../lib/transfer-detection');
      const result = await detectTransfers(7);

      const { rows } = await pool.query(
        "SELECT is_transfer, transfer_type FROM transactions WHERE plaid_transaction_id = 'tx-xfer-cc-1'"
      );
      assert.equal(rows[0].is_transfer, true);
      assert.equal(rows[0].transfer_type, 'cc_payment');
    });
  });

  describe('crypto/BTC savings', () => {
    before(async () => {
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
      await insertTx('tx-xfer-btc-1', acctId1, -100.00, today, 'Swan Bitcoin Purchase', 'Swan');
    });

    it('detects crypto purchases', async () => {
      const { detectTransfers } = require('../lib/transfer-detection');
      const result = await detectTransfers(7);

      const { rows } = await pool.query(
        "SELECT is_transfer, transfer_type FROM transactions WHERE plaid_transaction_id = 'tx-xfer-btc-1'"
      );
      assert.equal(rows[0].is_transfer, true);
      assert.equal(rows[0].transfer_type, 'crypto_savings');
    });
  });

  describe('529 contributions', () => {
    before(async () => {
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
      await insertTx('tx-xfer-529-1', acctId1, -250.00, today, 'NY Saves 529 Contribution', null);
    });

    it('detects 529 contributions', async () => {
      const { detectTransfers } = require('../lib/transfer-detection');
      const result = await detectTransfers(7);

      const { rows } = await pool.query(
        "SELECT is_transfer, transfer_type FROM transactions WHERE plaid_transaction_id = 'tx-xfer-529-1'"
      );
      assert.equal(rows[0].is_transfer, true);
      assert.equal(rows[0].transfer_type, '529_contribution');
    });
  });

  describe('idempotency', () => {
    before(async () => {
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
      await insertTx('tx-xfer-idem-1', acctId1, -200.00, today, 'Coinbase Purchase', 'Coinbase');
    });

    it('does not re-flag already flagged transactions', async () => {
      const { detectTransfers } = require('../lib/transfer-detection');

      // Run twice
      await detectTransfers(7);
      const result2 = await detectTransfers(7);

      // Second run should find 0 new transfers for this tx (it's already flagged)
      const { rows } = await pool.query(
        "SELECT count(*)::int AS count FROM transactions WHERE plaid_transaction_id = 'tx-xfer-idem-1' AND is_transfer = true"
      );
      assert.equal(rows[0].count, 1);
    });
  });

  describe('edge cases', () => {
    before(async () => {
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL, transfer_pair_id = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-%'");
    });

    it('does not match transfers with same account', async () => {
      // Both from same account — should NOT match as inter-account
      await insertTx('tx-xfer-same-1', acctId1, -300.00, today, 'Outgoing', null);
      await insertTx('tx-xfer-same-2', acctId1, 300.00, today, 'Incoming', null);

      const { detectTransfers } = require('../lib/transfer-detection');
      await detectTransfers(7);

      const { rows } = await pool.query(
        "SELECT is_transfer, transfer_type FROM transactions WHERE plaid_transaction_id = 'tx-xfer-same-1'"
      );
      // Should not be flagged as inter_account (same account)
      if (rows[0].is_transfer) {
        assert.notEqual(rows[0].transfer_type, 'inter_account');
      }
    });

    it('handles amount tolerance', async () => {
      // $500 out, $499.50 in — within $1 tolerance
      await insertTx('tx-xfer-tol-1', acctId1, -500.00, today, 'Transfer Out', null);
      await insertTx('tx-xfer-tol-2', acctId2, 499.50, today, 'Transfer In', null);

      // Reset flags
      await pool.query("UPDATE transactions SET is_transfer = false, transfer_type = NULL WHERE plaid_transaction_id LIKE 'tx-xfer-tol%'");

      const { detectTransfers } = require('../lib/transfer-detection');
      await detectTransfers(7);

      const { rows } = await pool.query(
        "SELECT is_transfer FROM transactions WHERE plaid_transaction_id = 'tx-xfer-tol-1'"
      );
      assert.equal(rows[0].is_transfer, true, 'Should match within $1 tolerance');
    });
  });
});
