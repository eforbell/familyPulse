'use strict';

require('dotenv').config();
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Requires a running Postgres with the schema applied
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

after(async () => {
  await pool.end();
});

describe('database schema', () => {
  it('applies migration 014 for recurring schema checks', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '014-recurring-expenses.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('applies migration 015 for cash flow forecast schema', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '015-cash-flow-forecast.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('applies migration 016 for category baseline exclusion', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '016-category-baseline-exclusion.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('applies migration 017 for transaction memory schema', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '017-transaction-memory.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('applies migration 018 for transaction identity overrides', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '018-transaction-identity-overrides.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  const expectedTables = [
    'items', 'accounts', 'transactions', 'categories', 'category_rules',
    'budget_snapshots', 'planning_goals', 'savings_signals',
    'magic_actions_log', 'anomalies', 'import_runs', 'dedup_runs', 'family_members', 'app_config',
    'recurring_expenses', 'recurring_expense_history',
    'planned_expenses', 'cash_flow_snapshots',
    'transaction_notes', 'transaction_attachments',
    'transaction_allocations',
    'merchant_rename_rules',
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

  it('every transaction has signed allocations that reconcile to its amount', async () => {
    const { rows: [result] } = await pool.query(`
      SELECT count(*)::int AS invalid_count
      FROM transactions t
      LEFT JOIN transaction_allocations ta ON ta.transaction_id = t.id
      GROUP BY t.id, t.amount
      HAVING count(ta.id) = 0 OR COALESCE(SUM(ta.amount), 0) <> t.amount
      LIMIT 1
    `);
    assert.equal(result?.invalid_count, undefined);
  });

  it('migration 025 is idempotent', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '025-normalized-transaction-allocations.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('app_config has primary key on key column', async () => {
    const { rows } = await pool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'app_config' AND constraint_type = 'PRIMARY KEY'
    `);
    assert.equal(rows.length, 1);
  });

  it('recurring_expenses identity index excludes the volatile schedule anchor', async () => {
    // Identity is (merchant_key, cashflow_type, frequency) only. The schedule
    // anchor drifts for weekday-anchored schedules (e.g. SSA pays the Nth
    // weekday), so including it would re-duplicate items as the day shifts.
    const { rows } = await pool.query(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'recurring_expenses'
        AND indexname = 'ux_recurring_expenses_identity'
    `);
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /\(merchant_key, cashflow_type, frequency\)/);
    assert.doesNotMatch(rows[0].indexdef, /schedule_anchor/);
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
