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
    assert.ok(typeof data.committed_total === 'number');
    assert.ok(typeof data.discretionary_total === 'number');
    assert.ok(typeof data.recurring_income_total === 'number');
    assert.ok(typeof data.recurring_count === 'number');
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

  it('GET /api/budget/trends returns correct shape with default months', async () => {
    const res = await req('api/budget/trends');
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.periods));
    assert.equal(data.periods.length, 6);
    assert.ok(Array.isArray(data.monthly));
    assert.equal(data.monthly.length, 6);

    // Each monthly entry has the expected fields
    for (const m of data.monthly) {
      assert.ok(typeof m.period === 'string');
      assert.match(m.period, /^\d{4}-\d{2}$/);
      assert.ok(typeof m.income === 'number');
      assert.ok(typeof m.spending === 'number');
      assert.ok(typeof m.net_cash_flow === 'number');
      assert.ok(Array.isArray(m.categories));
    }

    // net_cash_flow = income - spending
    for (const m of data.monthly) {
      const expected = Math.round((m.income - m.spending) * 100) / 100;
      assert.equal(m.net_cash_flow, expected);
    }
  });

  it('GET /api/budget/trends?months=3 respects months param', async () => {
    const res = await req('api/budget/trends?months=3');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.periods.length, 3);
    assert.equal(data.monthly.length, 3);
  });

  it('GET /api/budget/trends caps months at 12', async () => {
    const res = await req('api/budget/trends?months=99');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.periods.length, 12);
  });

  it('GET /api/budget/trends category entries have required fields', async () => {
    const res = await req('api/budget/trends');
    const data = await res.json();

    // Find a month that has category data
    const withCats = data.monthly.find(m => m.categories.length > 0);
    if (!withCats) return; // skip if no data

    for (const cat of withCats.categories) {
      assert.ok(typeof cat.id === 'number');
      assert.ok(typeof cat.name === 'string');
      assert.ok(typeof cat.spent === 'number');
      // color and icon may be null but should exist
      assert.ok('color' in cat);
      assert.ok('icon' in cat);
    }
  });

  it('GET /api/budget/trends requires parent auth', async () => {
    // Request without session cookie
    const res = await fetch(`${baseUrl}/api/budget/trends`);
    assert.ok(res.status === 401 || res.status === 403);
  });

  it('GET /api/budget/trends periods are chronological with current month last', async () => {
    const res = await req('api/budget/trends');
    const data = await res.json();

    // Periods should be sorted oldest → newest
    for (let i = 1; i < data.periods.length; i++) {
      assert.ok(data.periods[i] > data.periods[i - 1],
        `periods out of order: ${data.periods[i - 1]} >= ${data.periods[i]}`);
    }

    // Last period should be current month
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    assert.equal(data.periods[data.periods.length - 1], currentPeriod);
  });

  it('GET /api/budget/trends?months=1 returns minimum 1 period', async () => {
    const res = await req('api/budget/trends?months=1');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.periods.length, 1);
    assert.equal(data.monthly.length, 1);
  });

  it('GET /api/budget/trends?months=abc falls back to default 6', async () => {
    const res = await req('api/budget/trends?months=abc');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.periods.length, 6);
  });

  it('GET /api/budget/trends spending equals sum of category spent', async () => {
    const res = await req('api/budget/trends');
    const data = await res.json();

    for (const m of data.monthly) {
      const catTotal = m.categories.reduce((sum, c) => sum + c.spent, 0);
      const expected = Math.round(catTotal * 100) / 100;
      assert.equal(m.spending, expected,
        `${m.period}: spending ${m.spending} != category sum ${expected}`);
    }
  });

  it('GET /api/budget/trends generates missing snapshots on demand', async () => {
    // Use a far-future period that won't collide with real data
    const testPeriod = '2099-06';

    // Ensure no snapshots exist for this period
    await pool.query('DELETE FROM budget_snapshots WHERE period = $1', [testPeriod]);
    const { rows: before } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM budget_snapshots WHERE period = $1', [testPeriod]
    );
    assert.equal(before[0].cnt, 0, 'precondition: no snapshots for test period');

    // Call getBudgetTrends directly with a range that includes our test period
    const { getBudgetTrends } = require('../lib/budget-calculator');

    // Temporarily monkey-patch Date to make getBudgetTrends think current month is 2099-06
    const RealDate = global.Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(2099, 5, 15);  // June 2099
        return new RealDate(...args);
      }
      static now() { return new RealDate(2099, 5, 15).getTime(); }
    }
    global.Date = FakeDate;

    try {
      const data = await getBudgetTrends(1);

      // Snapshots should now exist for 2099-06
      const { rows: after } = await pool.query(
        'SELECT COUNT(*)::int AS cnt FROM budget_snapshots WHERE period = $1', [testPeriod]
      );
      assert.ok(after[0].cnt > 0, 'snapshots were generated on demand for missing period');

      // Response should include the period
      assert.equal(data.periods.length, 1);
      assert.equal(data.periods[0], testPeriod);
    } finally {
      global.Date = RealDate;
      // Cleanup
      await pool.query('DELETE FROM budget_snapshots WHERE period = $1', [testPeriod]);
    }
  });

  it('GET /api/budget/trends refreshes current-month snapshot with live data', async () => {
    const now = new Date();
    const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Get a category to use as a marker
    const { rows: cats } = await pool.query(
      "SELECT id FROM categories WHERE is_transfer_class = false AND is_income = false AND name != 'Uncategorized' LIMIT 1"
    );
    if (cats.length === 0) return; // skip if no categories
    const catId = cats[0].id;

    const { rows: originalRows } = await pool.query(
      'SELECT budgeted, actual_spent, updated_at FROM budget_snapshots WHERE category_id = $1 AND period = $2',
      [catId, currentPeriod]
    );
    const original = originalRows[0] || null;

    try {
      // Force a stale snapshot with a known value
      await pool.query(`
        INSERT INTO budget_snapshots (category_id, period, budgeted, actual_spent, updated_at)
        VALUES ($1, $2, 0, 999999.99, '2000-01-01')
        ON CONFLICT (category_id, period)
        DO UPDATE SET budgeted = EXCLUDED.budgeted, actual_spent = EXCLUDED.actual_spent, updated_at = EXCLUDED.updated_at
      `, [catId, currentPeriod]);

      // Verify the stale value is in place
      const { rows: stale } = await pool.query(
        'SELECT actual_spent, updated_at FROM budget_snapshots WHERE category_id = $1 AND period = $2',
        [catId, currentPeriod]
      );
      assert.equal(parseFloat(stale[0].actual_spent), 999999.99);

      // Call trends — should refresh current month snapshot
      const res = await req('api/budget/trends?months=1');
      assert.equal(res.status, 200);

      // The snapshot should now have a recent updated_at (not year 2000)
      const { rows: refreshed } = await pool.query(
        'SELECT actual_spent, updated_at FROM budget_snapshots WHERE category_id = $1 AND period = $2',
        [catId, currentPeriod]
      );
      assert.notEqual(parseFloat(refreshed[0].actual_spent), 999999.99,
        'current-month snapshot should be refreshed with live data, not stale sentinel');
      assert.ok(new Date(refreshed[0].updated_at) > new Date('2020-01-01'),
        'updated_at should be recent, not the stale year-2000 timestamp');
    } finally {
      if (original) {
        await pool.query(`
          INSERT INTO budget_snapshots (category_id, period, budgeted, actual_spent, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (category_id, period)
          DO UPDATE SET budgeted = EXCLUDED.budgeted, actual_spent = EXCLUDED.actual_spent, updated_at = EXCLUDED.updated_at
        `, [catId, currentPeriod, original.budgeted, original.actual_spent, original.updated_at]);
      } else {
        await pool.query(
          'DELETE FROM budget_snapshots WHERE category_id = $1 AND period = $2',
          [catId, currentPeriod]
        );
      }
    }
  });
});
