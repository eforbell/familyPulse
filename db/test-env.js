'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.join(__dirname, '..');
const TEST_ENV_PATH = path.join(ROOT_DIR, '.env.test');
const TEST_ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.test.example');

function fail(message) {
  throw new Error(`Test DB setup failed: ${message}`);
}

function extractDatabaseName(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

function isSafeTestDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;

  const dbName = extractDatabaseName(databaseUrl);
  if (!dbName) return false;

  return /(^test[_-])|([_-]test($|[_-]))/i.test(dbName);
}

function loadTestEnv() {
  if (fs.existsSync(TEST_ENV_PATH)) {
    dotenv.config({ path: TEST_ENV_PATH, override: true });
    return TEST_ENV_PATH;
  }

  if (!process.env.DATABASE_URL) {
    fail(
      `.env.test is missing and DATABASE_URL is not set.\n` +
      `Create ${path.basename(TEST_ENV_PATH)} from ${path.basename(TEST_ENV_EXAMPLE_PATH)} ` +
      `or export a dedicated test DATABASE_URL before running test DB commands.`
    );
  }

  return null;
}

function ensureTestDatabaseEnvironment() {
  const loadedEnvPath = loadTestEnv();

  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test';
  }

  if (process.env.NODE_ENV !== 'test') {
    fail(`NODE_ENV must be "test", received "${process.env.NODE_ENV}".`);
  }

  if (!isSafeTestDatabaseUrl(process.env.DATABASE_URL)) {
    const dbName = extractDatabaseName(process.env.DATABASE_URL) || '<unparsed>';
    const source = loadedEnvPath ? path.basename(loadedEnvPath) : 'environment';
    fail(
      `DATABASE_URL from ${source} must target a dedicated test database. ` +
      `Resolved database name: "${dbName}". Expected a name like "familypulse_test".`
    );
  }

  return {
    databaseUrl: process.env.DATABASE_URL,
    databaseName: extractDatabaseName(process.env.DATABASE_URL),
    envPath: loadedEnvPath
  };
}

module.exports = {
  ensureTestDatabaseEnvironment,
  extractDatabaseName,
  isSafeTestDatabaseUrl
};
