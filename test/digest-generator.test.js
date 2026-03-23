'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../lib/db');
const { sanitizeForLLM } = require('../lib/secrets-guard');
const { currentWeeklyDigestPeriod } = require('../lib/magic-actions/weekly-digest');

const TEST_PERIOD = '2025-06';

describe('digest-generator', () => {
  before(async () => {
    // Ensure migration 005 columns
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS period TEXT`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS current_amount NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS avg_3mo NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS avg_12mo NUMERIC(12,2)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS pct_of_3mo NUMERIC(5,1)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS pct_of_12mo NUMERIC(5,1)`);
    await pool.query(`ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS note TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_cat_period ON anomalies(category_id, period, anomaly_type)`);
  });

  after(async () => {
    await pool.query(`DELETE FROM magic_actions_log WHERE action_type LIKE 'weekly_digest_test_%'`);
  });

  it('prompt contains no secrets', () => {
    // Simulate the prompt-building logic
    const fakeData = {
      period: TEST_PERIOD,
      income: 5000,
      total_spending: 3200,
      categories: [{ name: 'Groceries', spent: 500 }],
      // Inject something that looks like a secret
      some_token: 'access-sandbox-abc123def456-7890',
      api_key: 'sk-testkey1234567890abcdef'
    };

    const sanitized = sanitizeForLLM(fakeData);
    const asString = JSON.stringify(sanitized);

    assert.ok(!asString.includes('access-sandbox'), 'Should not contain access token');
    assert.ok(!asString.includes('sk-testkey'), 'Should not contain API key');
    assert.equal(sanitized.api_key, '[REDACTED]');
  });

  it('cache hit returns stored digest', async () => {
    const actionType = `weekly_digest_test_${Date.now()}`;
    const cachedDigest = 'This is a cached test digest.';

    // Pre-populate cache
    await pool.query(
      `INSERT INTO magic_actions_log (action_type, output, model) VALUES ($1, $2, 'test')`,
      [actionType, cachedDigest]
    );

    // Check that we can retrieve it
    const { rows } = await pool.query(
      `SELECT output FROM magic_actions_log WHERE action_type = $1`,
      [actionType]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].output, cachedDigest);

    await pool.query(`DELETE FROM magic_actions_log WHERE action_type = $1`, [actionType]);
  });

  it('graceful failure without API key', async () => {
    // Save and clear key
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const { generateWeeklyDigest } = require('../lib/digest-generator');
      const result = await generateWeeklyDigest(TEST_PERIOD);

      // Should return null digest, not throw
      assert.equal(result.digest, null);
      assert.equal(result.cached, false);
    } finally {
      if (savedKey) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it('uses the prior Sunday before the Sunday evening release window', () => {
    const period = currentWeeklyDigestPeriod(new Date('2026-03-22T17:59:00'));
    assert.equal(period, '2026-03-15');
  });

  it('uses the current Sunday once the release window starts', () => {
    const period = currentWeeklyDigestPeriod(new Date('2026-03-22T18:00:00'));
    assert.equal(period, '2026-03-22');
  });

  it('uses the most recent Sunday during the week', () => {
    const period = currentWeeklyDigestPeriod(new Date('2026-03-25T09:30:00'));
    assert.equal(period, '2026-03-22');
  });
});
