'use strict';

const { execSync } = require('child_process');
const { Pool } = require('pg');
const { ensureTestDatabaseEnvironment } = require('../../../db/test-env');
const { hashPassphrase } = require('../../../lib/auth');

module.exports = async function globalSetup() {
  ensureTestDatabaseEnvironment();

  // Reset, migrate, seed the test database
  execSync('npm run test:prepare', {
    cwd: require('path').join(__dirname, '..', '..', '..'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });

  // Set a passphrase on Eric so authEnabled() returns true
  // Without this, the auth gate is completely bypassed
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = hashPassphrase('testpass');
    await pool.query(
      "UPDATE family_members SET passphrase_hash = $1 WHERE name = 'Eric' AND role = 'parent'",
      [hash]
    );
  } finally {
    await pool.end();
  }
};
