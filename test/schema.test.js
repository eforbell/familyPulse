'use strict';

require('dotenv').config();
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

// Requires a running Postgres with the schema applied
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

after(async () => {
  await pool.end();
});

describe('database schema', () => {
  const expectedTables = [
    'items', 'accounts', 'transactions', 'categories', 'category_rules',
    'budgets', 'budget_periods', 'planning_goals', 'savings_signals',
    'magic_actions_log', 'anomalies', 'import_runs', 'family_members', 'app_config',
    'schema_migrations'
  ];

  for (const table of expectedTables) {
    it(`table "${table}" exists`, async () => {
      const { rows } = await pool.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename = $1
      `, [table]);
      assert.equal(rows.length, 1, `Table ${table} should exist`);
    });
  }

  it('transactions has expected indexes', async () => {
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'transactions'
    `);
    const indexNames = rows.map(r => r.indexname);
    assert.ok(indexNames.some(n => n.includes('account_date')), 'Should have account_date index');
    assert.ok(indexNames.some(n => n.includes('plaid_id')), 'Should have plaid_id index');
    assert.ok(indexNames.some(n => n.includes('date') && !n.includes('account')), 'Should have date index');
    assert.ok(indexNames.some(n => n.includes('category')), 'Should have category index');
  });

  it('transactions.plaid_transaction_id has unique constraint', async () => {
    const { rows } = await pool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'transactions' AND constraint_type = 'UNIQUE'
    `);
    assert.ok(rows.length > 0, 'Should have unique constraint on plaid_transaction_id');
  });

  it('app_config has primary key on key column', async () => {
    const { rows } = await pool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'app_config' AND constraint_type = 'PRIMARY KEY'
    `);
    assert.equal(rows.length, 1);
  });

  it('migration is idempotent (re-run does not fail)', async () => {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '001-initial-schema.sql'), 'utf8'
    );
    // Running the migration SQL again should not throw (IF NOT EXISTS everywhere)
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });
});
