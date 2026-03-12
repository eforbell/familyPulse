#!/usr/bin/env node
'use strict';

/**
 * migrate.js — applies numbered SQL migrations in order.
 * Tracks applied migrations in a `schema_migrations` table.
 * Re-running is idempotent: already-applied migrations are skipped.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { ensureTestDatabaseEnvironment } = require('./test-env');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  if (process.env.NODE_ENV === 'test') {
    ensureTestDatabaseEnvironment();
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Ensure tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const appliedSet = new Set(applied.map(r => r.filename));

    // Read migration files, sorted
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  skip: ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`  apply: ${file}`);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }

    console.log(count === 0 ? 'All migrations already applied.' : `Applied ${count} migration(s).`);
  } finally {
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
