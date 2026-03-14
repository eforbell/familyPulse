'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { app } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let baseUrl;
let sessionToken;

function req(path, opts = {}) {
  return fetch(`${baseUrl}/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${sessionToken}`,
      ...opts.headers
    }
  });
}

describe('budget API', () => {
  before(async () => {
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Create a parent session for auth (budget routes require parent)
    const { rows: [parent] } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'parent' LIMIT 1"
    );
    sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)',
      [sessionToken, parent.id, expiresAt]
    );
  });

  after(async () => {
    await pool.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
    server.close();
    await pool.end();
  });

  it('GET /api/budget/summary returns correct shape', async () => {
    const res = await req('api/budget/summary');
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.period);
    assert.ok(Array.isArray(data.categories));
    assert.ok(typeof data.income === 'object');
    assert.ok(typeof data.income.current === 'number');
    assert.ok(typeof data.income.prior === 'number');
    assert.ok(typeof data.spending === 'object');
    assert.ok(typeof data.spending.actual === 'number');
    assert.ok(typeof data.spending.budgeted === 'number');
    assert.ok(typeof data.net_cash_flow === 'object');
    assert.ok(typeof data.uncategorized === 'object');
    assert.ok(typeof data.uncategorized.spent === 'number');
    assert.ok(typeof data.uncategorized.count === 'number');
  });

  it('GET /api/budget/summary?period=YYYY-MM filters correctly', async () => {
    const res = await req('api/budget/summary?period=2025-01');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.period, '2025-01');
  });

  it('GET /api/budget/category/:id returns category detail', async () => {
    // Get a valid category id first
    const summaryRes = await req('api/budget/summary');
    const summary = await summaryRes.json();
    if (summary.categories.length === 0) return; // skip if no categories

    const catId = summary.categories[0].id;
    const res = await req(`api/budget/category/${catId}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    assert.ok(data.name);
    assert.ok(Array.isArray(data.transactions));
  });

  it('GET /api/budget/category/999999 returns 404', async () => {
    const res = await req('api/budget/category/999999');
    assert.equal(res.status, 404);
  });

  it('POST /api/budget/snapshot validates period', async () => {
    const res = await req('api/budget/snapshot', {
      method: 'POST',
      body: JSON.stringify({ period: 'bad' })
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/budget/snapshot creates snapshot', async () => {
    const res = await req('api/budget/snapshot', {
      method: 'POST',
      body: JSON.stringify({ period: '2025-01' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.period, '2025-01');
  });

  it('POST /api/budget/backfill succeeds', async () => {
    const res = await req('api/budget/backfill', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.periods === 'number');
  });
});
