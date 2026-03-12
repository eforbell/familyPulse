#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const { ensureTestDatabaseEnvironment } = require('./test-env');

async function resetTestDb() {
  const { databaseUrl, databaseName } = ensureTestDatabaseEnvironment();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log(`Resetting test database schema for ${databaseName}...`);
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO public');
    console.log('Test schema reset complete.');
  } finally {
    await pool.end();
  }
}

resetTestDb().catch(err => {
  console.error('Test DB reset failed:', err.message);
  process.exit(1);
});
