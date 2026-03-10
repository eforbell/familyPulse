'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

// Simple test HTTP helper
const PORT = 3099;
let server;

function req(path, opts = {}) {
  const url = `http://127.0.0.1:${PORT}/${path}`;
  return fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers }
  });
}

describe('budget API', () => {
  before(async () => {
    server = app.listen(PORT);
    await new Promise(r => server.on('listening', r));
  });

  after(async () => {
    server.close();
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
