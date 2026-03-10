'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../lib/db');

const TEST_PERIOD = '2025-06';

describe('anomaly-detector', () => {
  let testCatId, smallCatId, accountId;

  before(async () => {
    // Run migration 005 columns if needed
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS period TEXT`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS current_amount NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS avg_3mo NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS avg_12mo NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS pct_of_3mo NUMERIC(5,1)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS pct_of_12mo NUMERIC(5,1)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS note TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_cat_period ON anomalies(category_id, period, anomaly_type)`);

    // Seed config
    await pool.query(`INSERT INTO app_config (key, value) VALUES ('anomaly_threshold_pct', '130') ON CONFLICT (key) DO UPDATE SET value = '130'`);
    await pool.query(`INSERT INTO app_config (key, value) VALUES ('anomaly_min_avg_dollars', '25') ON CONFLICT (key) DO UPDATE SET value = '25'`);

    // Test category with sizable spending
    const { rows: [cat] } = await pool.query(
      `INSERT INTO categories (name, color, budget_amount, is_income, is_transfer_class, icon)
       VALUES ('TestAnomalyCat', '#ef4444', 500, false, false, '🔥')
       ON CONFLICT (name) DO UPDATE SET budget_amount = 500
       RETURNING id`
    );
    testCatId = cat.id;

    // Small-dollar category (should be excluded)
    const { rows: [small] } = await pool.query(
      `INSERT INTO categories (name, color, budget_amount, is_income, is_transfer_class, icon)
       VALUES ('TestSmallCat', '#999', 50, false, false, '🪙')
       ON CONFLICT (name) DO UPDATE SET budget_amount = 50
       RETURNING id`
    );
    smallCatId = small.id;

    // Get or create test account
    const { rows: accounts } = await pool.query('SELECT id FROM accounts LIMIT 1');
    if (accounts.length > 0) {
      accountId = accounts[0].id;
    } else {
      const { rows: [item] } = await pool.query(
        `INSERT INTO items (access_token, item_id, institution_name, status)
         VALUES ('test-token', 'test-item-anomaly', 'Test Bank', 'good')
         ON CONFLICT (item_id) DO UPDATE SET institution_name = 'Test Bank'
         RETURNING id`
      );
      const { rows: [acct] } = await pool.query(
        `INSERT INTO accounts (plaid_account_id, item_id, name, type, mask)
         VALUES ('test-acct-anomaly', $1, 'Test Checking', 'depository', '9999')
         ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Test Checking'
         RETURNING id`,
        [item.id]
      );
      accountId = acct.id;
    }

    // Clean up any prior test data
    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id LIKE 'test-anomaly-%'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id IN ($1, $2)`, [testCatId, smallCatId]);

    // Prior 3 months: $100/mo average for TestAnomalyCat
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer) VALUES
        ('test-anomaly-p1', $1, 100.00, '2025-05-10', 'Prior 1', $2, false),
        ('test-anomaly-p2', $1, 100.00, '2025-04-10', 'Prior 2', $2, false),
        ('test-anomaly-p3', $1, 100.00, '2025-03-10', 'Prior 3', $2, false)
    `, [accountId, testCatId]);

    // Small-dollar category: $20/mo average (below $25 min)
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer) VALUES
        ('test-anomaly-s1', $1, 20.00, '2025-05-10', 'Small 1', $2, false),
        ('test-anomaly-s2', $1, 20.00, '2025-04-10', 'Small 2', $2, false),
        ('test-anomaly-s3', $1, 20.00, '2025-03-10', 'Small 3', $2, false)
    `, [accountId, smallCatId]);
  });

  after(async () => {
    await pool.query(`DELETE FROM anomalies WHERE category_id IN ($1, $2)`, [testCatId, smallCatId]);
    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id LIKE 'test-anomaly-%'`);
    await pool.query(`DELETE FROM categories WHERE name IN ('TestAnomalyCat', 'TestSmallCat')`);
  });

  it('normal spending (100% of avg) produces no anomaly', async () => {
    // Current month at $100 = exactly 100% of 3mo avg
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-norm', $1, 100.00, '2025-06-15', 'Normal', $2, false)
    `, [accountId, testCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    const result = await detectAnomalies(TEST_PERIOD);

    const mine = result.anomalies.filter(a => a.category_id === testCatId);
    assert.equal(mine.length, 0, 'Should not flag 100% of avg');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-norm'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [testCatId]);
  });

  it('130% of 3mo avg is flagged', async () => {
    // $130 = 130% of $100 avg — at boundary, need > 130%
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-spike', $1, 131.00, '2025-06-15', 'Spike', $2, false)
    `, [accountId, testCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    const result = await detectAnomalies(TEST_PERIOD);

    const spike3 = result.anomalies.find(a => a.category_id === testCatId && a.anomaly_type === 'spending_spike_3mo');
    assert.ok(spike3, 'Should flag spending_spike_3mo at 131%');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-spike'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [testCatId]);
  });

  it('129% is not flagged', async () => {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-below', $1, 129.00, '2025-06-15', 'Below', $2, false)
    `, [accountId, testCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    const result = await detectAnomalies(TEST_PERIOD);

    const spike3 = result.anomalies.find(a => a.category_id === testCatId && a.anomaly_type === 'spending_spike_3mo');
    assert.equal(spike3, undefined, 'Should NOT flag at 129%');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-below'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [testCatId]);
  });

  it('small-dollar exclusion ($20 avg ignored)', async () => {
    // Spend $100 in small cat (500% of $20 avg) — should still be excluded
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-small', $1, 100.00, '2025-06-15', 'Big on small cat', $2, false)
    `, [accountId, smallCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    const result = await detectAnomalies(TEST_PERIOD);

    const mine = result.anomalies.filter(a => a.category_id === smallCatId);
    assert.equal(mine.length, 0, 'Should exclude categories with avg < $25');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-small'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [smallCatId]);
  });

  it('idempotency — double-run does not duplicate', async () => {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-idem', $1, 200.00, '2025-06-15', 'Idem', $2, false)
    `, [accountId, testCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    await detectAnomalies(TEST_PERIOD);
    await detectAnomalies(TEST_PERIOD);

    const { rows } = await pool.query(
      `SELECT * FROM anomalies WHERE category_id = $1 AND period = $2`,
      [testCatId, TEST_PERIOD]
    );
    // Should have at most one row per anomaly_type
    const types = rows.map(r => r.anomaly_type);
    const unique = [...new Set(types)];
    assert.equal(types.length, unique.length, 'No duplicate anomalies after double-run');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-idem'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [testCatId]);
  });

  it('acknowledge flow', async () => {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, category_id, is_transfer)
      VALUES ('test-anomaly-cur-ack', $1, 200.00, '2025-06-15', 'Ack test', $2, false)
    `, [accountId, testCatId]);

    const { detectAnomalies } = require('../lib/anomaly-detector');
    await detectAnomalies(TEST_PERIOD);

    // Get unacknowledged
    const { rows: unacked } = await pool.query(
      `SELECT id FROM anomalies WHERE category_id = $1 AND period = $2 AND acknowledged = false`,
      [testCatId, TEST_PERIOD]
    );
    assert.ok(unacked.length > 0, 'Should have unacknowledged anomalies');

    // Acknowledge
    await pool.query(
      `UPDATE anomalies SET acknowledged = true, note = 'expected' WHERE id = $1`,
      [unacked[0].id]
    );

    // Verify
    const { rows: acked } = await pool.query(
      `SELECT * FROM anomalies WHERE id = $1`,
      [unacked[0].id]
    );
    assert.equal(acked[0].acknowledged, true);
    assert.equal(acked[0].note, 'expected');

    await pool.query(`DELETE FROM transactions WHERE plaid_transaction_id = 'test-anomaly-cur-ack'`);
    await pool.query(`DELETE FROM anomalies WHERE category_id = $1`, [testCatId]);
  });
});
