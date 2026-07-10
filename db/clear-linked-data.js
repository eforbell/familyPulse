#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { Pool } = require('pg');

const CONFIRM_FLAG = '--yes';

function usage() {
  console.error(
    'Usage: node db/clear-linked-data.js --yes\n' +
    '\n' +
    'Deletes linked financial data and derived artifacts while preserving:\n' +
    '- family_members\n' +
    '- sessions\n' +
    '- app_config\n' +
    '- categories\n' +
    '- category_rules\n' +
    '- learned_category_rules\n' +
    '- suggestion_rejections\n' +
    '- schema_migrations\n'
  );
}

function databaseNameFromUrl(connectionString) {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return '<unparsed>';
  }
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    usage();
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dbName = databaseNameFromUrl(process.env.DATABASE_URL);

  // Preserve the Monarch import sentinel so historical import remains available.
  const sentinelItemId = 'monarch-import';

  // Keep the wipe constrained to synced financial data and derivative tables.
  const statements = [
    { table: 'magic_actions_log', sql: 'DELETE FROM magic_actions_log' },
    { table: 'budget_snapshots', sql: 'DELETE FROM budget_snapshots' },
    { table: 'anomalies', sql: 'DELETE FROM anomalies' },
    { table: 'import_runs', sql: 'DELETE FROM import_runs' },
    { table: 'link_sessions', sql: 'DELETE FROM link_sessions' },
    {
      table: 'monarch_import_accounts',
      sql: 'DELETE FROM accounts WHERE item_id IN (SELECT id FROM items WHERE item_id = $1)',
      params: [sentinelItemId]
    },
    {
      table: 'items',
      sql: 'DELETE FROM items WHERE item_id != $1',
      params: [sentinelItemId]
    },
    {
      table: 'monarch_import_sentinel',
      sql: `
        INSERT INTO items (access_token, item_id, institution_name, status)
        VALUES ('n/a', $1, 'Monarch Money (Import)', 'import')
        ON CONFLICT (item_id) DO NOTHING
      `,
      params: [sentinelItemId]
    }
  ];

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];

      for (const step of statements) {
        const result = await client.query(step.sql, step.params || []);
        results.push({ table: step.table, deleted: result.rowCount || 0 });
      }

      await client.query('COMMIT');

      console.log(`Cleared linked financial data from database "${dbName}".`);
      for (const result of results) {
        console.log(`- ${result.table}: ${result.deleted}`);
      }
      console.log('Preserved categories, rules, learned categorization intent, family members, sessions, app_config, schema migrations, and the Monarch import sentinel item.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Clear linked data failed:', err.message);
  process.exit(1);
});
