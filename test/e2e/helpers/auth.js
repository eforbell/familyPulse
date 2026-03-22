'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool || pool.ending) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

/**
 * Create a session for a family member and inject the cookie into the page context.
 * Must be called BEFORE page.goto().
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ role?: string, name?: string }} filter
 * @returns {Promise<{ token: string, memberId: number }>}
 */
async function loginAs(page, { role, name } = {}) {
  const conditions = [];
  const params = [];

  if (role) {
    params.push(role);
    conditions.push(`role = $${params.length}`);
  }
  if (name) {
    params.push(name);
    conditions.push(`name = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await getPool().query(
    `SELECT id FROM family_members ${where} LIMIT 1`,
    params
  );

  if (rows.length === 0) {
    throw new Error(`No family member found matching: ${JSON.stringify({ role, name })}`);
  }

  const memberId = rows[0].id;
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await getPool().query(
    'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)',
    [token, memberId, expiresAt]
  );

  await page.context().addCookies([{
    name: 'fp_session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }]);

  return { token, memberId };
}

/**
 * Delete a session row by token.
 * @param {string} token
 */
async function cleanupSession(token) {
  if (!token) return;
  await getPool().query('DELETE FROM sessions WHERE token = $1', [token]);
}

/**
 * Tear down the pg pool. Call in afterAll.
 */
async function closePool() {
  if (pool && !pool.ending) {
    await pool.end();
    pool = null;
  }
}

module.exports = { loginAs, cleanupSession, closePool };
