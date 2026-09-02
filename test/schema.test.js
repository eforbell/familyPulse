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
    'paycheck_events', 'paycheck_deposits', 'paycheck_category_mappings',
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

  it('migration 026 is idempotent', async () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '026-paycheck-breakdowns.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
    });
  });

  it('migration 027 is idempotent and removes the legacy paycheck table', async () => {
    const { rows: [member] } = await pool.query("SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1");
    const { rows: [item] } = await pool.query(
      "INSERT INTO items (access_token, item_id, institution_name, status) VALUES ('schema-pay-token','schema-pay-item','Schema Bank','good') RETURNING id"
    );
    const { rows: [account] } = await pool.query(
      "INSERT INTO accounts (plaid_account_id,item_id,name,type,subtype) VALUES ('schema-pay-account',$1,'Checking','depository','checking') RETURNING id",
      [item.id]
    );
    const { rows: [transaction] } = await pool.query(
      "INSERT INTO transactions (plaid_transaction_id,account_id,amount,date,name,pending,is_transfer,source) VALUES ('schema-pay-tx',$1,-90,'2098-01-01','Employer',false,false,'plaid') RETURNING id",
      [account.id]
    );
    const { rows: [legacyPaycheck] } = await pool.query(
      `INSERT INTO paychecks (transaction_id,member_id,employer,gross_earnings,federal_tax,source_net_amount,created_by)
       VALUES ($1,$2,'Employer',100,10,90,$2) RETURNING id`, [transaction.id, member.id]
    );
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '027-multi-deposit-paychecks.sql'),
      'utf8'
    );
    await assert.doesNotReject(async () => {
      await pool.query(sql);
      await pool.query(sql);
    });
    const { rows: [migrated] } = await pool.query(
      `SELECT pe.id, pe.gross_earnings::text, pd.transaction_id, pd.deductions_applied,
              pd.source_net_amount::text, pd.reconciliation_status
       FROM paycheck_events pe JOIN paycheck_deposits pd ON pd.paycheck_event_id = pe.id
       WHERE pd.transaction_id = $1`, [transaction.id]
    );
    assert.equal(migrated.id, legacyPaycheck.id);
    assert.deepEqual(migrated, {
      id: legacyPaycheck.id, gross_earnings: '100.00', transaction_id: transaction.id,
      deductions_applied: true, source_net_amount: '90.00', reconciliation_status: 'matched'
    });
    const { rows: [legacy] } = await pool.query("SELECT to_regclass('public.paychecks') AS name");
    assert.equal(legacy.name, null);
    await pool.query('DELETE FROM paycheck_events WHERE id = $1', [migrated.id]);
    await pool.query('DELETE FROM items WHERE id = $1', [item.id]);
  });

  it('payroll categories have immutable system identities and stay out of discretionary baselines', async () => {
    const { rows } = await pool.query(
      `SELECT c.system_key, c.exclude_from_baseline, c.exclude_from_learning
       FROM paycheck_category_mappings pcm
       JOIN categories c ON c.id = pcm.category_id
       ORDER BY pcm.field_key`
    );
    assert.equal(rows.length, 7);
    assert.ok(rows.every(row => row.system_key?.startsWith('paycheck.')));
    assert.ok(rows.every(row => row.exclude_from_baseline === true));
    assert.ok(rows.every(row => row.exclude_from_learning === true));
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
