#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { ensureTestDatabaseEnvironment } = require('./test-env');

const SEED_PATH = path.join(__dirname, 'seed.sql');

async function seedTestDb() {
  const { databaseUrl, databaseName } = ensureTestDatabaseEnvironment();
  const pool = new Pool({ connectionString: databaseUrl });
  const sql = fs.readFileSync(SEED_PATH, 'utf8');

  try {
    console.log(`Seeding test database ${databaseName}...`);
    await pool.query(sql);
    console.log('Test seed complete.');
  } finally {
    await pool.end();
  }
}

seedTestDb().catch(err => {
  console.error('Test DB seed failed:', err.message);
  process.exit(1);
});
