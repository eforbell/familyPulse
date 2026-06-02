'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { app } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let baseUrl;
let parentSessionToken;
let kidSessionToken;
let createdExpenseId;

function futureDate(daysAhead = 15) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
function futureMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return d.toISOString().slice(0, 7);
}
let createdIncomeId;

function req(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${parentSessionToken}`,
      ...opts.headers
    }
  });
}

function kidReq(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${kidSessionToken}`,
      ...opts.headers
    }
  });
}

function unauthReq(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('planned expenses API', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Ensure migration is applied
    const fs = require('fs');
    const path = require('path');
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '015-cash-flow-forecast.sql'),
      'utf8'
    );
    await pool.query(migrationSql);
    const migration016Sql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '016-category-baseline-exclusion.sql'),
      'utf8'
    );
    await pool.query(migration016Sql);

    // Create sessions
    const { rows: parents } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1"
    );
    const { rows: kids } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'kid' ORDER BY id LIMIT 1"
    );

    parentSessionToken = crypto.randomUUID();
    kidSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3), ($4, $5, $6)',
      [parentSessionToken, parents[0].id, expiresAt, kidSessionToken, kids[0].id, expiresAt]
    );
  });

  after(async () => {
    // Clean up test data
    await pool.query("DELETE FROM planned_expenses WHERE name LIKE 'Test:%'");
    await pool.query('DELETE FROM sessions WHERE token IN ($1, $2)', [parentSessionToken, kidSessionToken]);
    server.close();
    await pool.end();
  });

  describe('POST /api/cash-flow/planned-expenses', () => {
    it('creates a planned expense (parent)', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test: New tires',
          amount: 800,
          scheduled_date: futureDate(),
          notes: 'All four tires'
        })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, 'Test: New tires');
      assert.equal(Number(data.amount), 800);
      assert.equal(data.status, 'active');
      assert.ok(data.id);
      createdExpenseId = data.id;
    });

    it('rejects missing name', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ amount: 100, scheduled_date: futureDate() })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /name is required/);
    });

    it('rejects negative amount', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Bad', amount: -50, scheduled_date: futureDate() })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /amount must be a positive number/);
    });

    it('rejects zero amount', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Zero', amount: 0, scheduled_date: futureDate() })
      });
      assert.equal(res.status, 400);
    });

    it('rejects past date (before current month)', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Old', amount: 100, scheduled_date: '2020-01-01' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /current month or future/);
    });

    it('rejects kid session (parent-only)', async () => {
      const res = await kidReq('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Kid try', amount: 100, scheduled_date: futureDate() })
      });
      assert.ok([401, 403].includes(res.status));
    });

    it('rejects unauthenticated request', async () => {
      const res = await unauthReq('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Unauth', amount: 100, scheduled_date: futureDate() })
      });
      assert.equal(res.status, 401);
    });
  });

  describe('GET /api/cash-flow/planned-expenses', () => {
    it('lists active planned expenses', async () => {
      const res = await req('api/cash-flow/planned-expenses');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.planned_expenses));
      const testExpense = data.planned_expenses.find(pe => pe.name === 'Test: New tires');
      assert.ok(testExpense, 'Should contain the created expense');
      assert.equal(Number(testExpense.amount), 800);
    });

    it('rejects kid session for list (parent-only)', async () => {
      const res = await kidReq('api/cash-flow/planned-expenses');
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('PATCH /api/cash-flow/planned-expenses/:id', () => {
    it('updates amount and notes', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ amount: 950, notes: 'Updated: premium tires' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(Number(data.amount), 950);
      assert.equal(data.notes, 'Updated: premium tires');
    });

    it('updates status to completed', async () => {
      // Create a separate expense to mark complete
      const createRes = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Complete me', amount: 50, scheduled_date: futureDate() })
      });
      const created = await createRes.json();

      const res = await req(`api/cash-flow/planned-expenses/${created.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'completed');
    });

    it('rejects past scheduled_date on update', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_date: '2020-01-01' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /current month or future/);
    });

    it('rejects invalid scheduled_date on update', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_date: 'not-a-date' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /valid date/);
    });

    it('rejects invalid status', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'invalid' })
      });
      assert.equal(res.status, 400);
    });

    it('returns 404 for non-existent id', async () => {
      const res = await req('api/cash-flow/planned-expenses/999999', {
        method: 'PATCH',
        body: JSON.stringify({ amount: 100 })
      });
      assert.equal(res.status, 404);
    });

    it('rejects kid session', async () => {
      const res = await kidReq(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ amount: 100 })
      });
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('DELETE /api/cash-flow/planned-expenses/:id', () => {
    it('soft-deletes a planned expense', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'DELETE'
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.deleted, true);

      // Verify it no longer appears in the list
      const listRes = await req('api/cash-flow/planned-expenses');
      const listData = await listRes.json();
      const found = listData.planned_expenses.find(pe => pe.id === createdExpenseId);
      assert.ok(!found, 'Deleted expense should not appear in active list');
    });

    it('returns 404 for already-deleted expense', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'DELETE'
      });
      assert.equal(res.status, 404);
    });

    it('rejects kid session', async () => {
      const res = await kidReq(`api/cash-flow/planned-expenses/${createdExpenseId}`, {
        method: 'DELETE'
      });
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('GET /api/cash-flow/forecast', () => {
    it('returns forecast with projections, danger zones, monthly outlook, and excess liquidity', async () => {
      // Clear any cached forecast first
      await pool.query('DELETE FROM cash_flow_snapshots');

      const res = await req('api/cash-flow/forecast');
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(Array.isArray(data.projections), 'Should have projections array');
      assert.ok(Array.isArray(data.danger_zones), 'Should have danger_zones array');
      assert.ok(Array.isArray(data.monthly_outlook), 'Should have monthly_outlook array');
      assert.ok(data.excess_liquidity, 'Should have excess_liquidity object');
      assert.ok(data.meta, 'Should have meta object');
      assert.ok(data.meta.horizon_days > 0);
    });

    it('returns cached forecast on second call', async () => {
      const res = await req('api/cash-flow/forecast');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.meta.cached, true);
    });

    it('rejects kid session', async () => {
      const res = await kidReq('api/cash-flow/forecast');
      assert.ok([401, 403].includes(res.status));
    });

    it('invalidates cached forecast when category baseline exclusion changes', async () => {
      await pool.query('DELETE FROM cash_flow_snapshots');
      const firstRes = await req('api/cash-flow/forecast');
      assert.equal(firstRes.status, 200);

      const { rows: [category] } = await pool.query(
        "SELECT id, exclude_from_baseline FROM categories WHERE is_income = false AND is_transfer_class = false ORDER BY id LIMIT 1"
      );
      assert.ok(category, 'Expected at least one spending category');

      const updateRes = await req(`api/categories/${category.id}`, {
        method: 'PUT',
        body: JSON.stringify({ exclude_from_baseline: !category.exclude_from_baseline })
      });
      assert.equal(updateRes.status, 200);

      const { rows: snapshotRows } = await pool.query('SELECT count(*)::int AS count FROM cash_flow_snapshots');
      assert.equal(snapshotRows[0].count, 0);
    });
  });

  describe('POST /api/cash-flow/forecast/refresh', () => {
    it('force-refreshes the forecast (parent-only)', async () => {
      const res = await req('api/cash-flow/forecast/refresh', { method: 'POST' });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.projections));
      assert.ok(data.meta);
      // Fresh computation should not have cached flag
      assert.ok(!data.meta.cached);
    });

    it('rejects kid session', async () => {
      const res = await kidReq('api/cash-flow/forecast/refresh', { method: 'POST' });
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('GET /api/cash-flow/danger-zones', () => {
    it('returns danger zones array', async () => {
      const res = await req('api/cash-flow/danger-zones');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.danger_zones));
    });

    it('rejects kid session', async () => {
      const res = await kidReq('api/cash-flow/danger-zones');
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('GET /api/cash-flow/monthly-outlook', () => {
    it('returns monthly outlook and excess liquidity', async () => {
      const res = await req('api/cash-flow/monthly-outlook');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.monthly_outlook));
      assert.ok(data.excess_liquidity);
    });

    it('rejects kid session', async () => {
      const res = await kidReq('api/cash-flow/monthly-outlook');
      assert.ok([401, 403].includes(res.status));
    });
  });

  describe('planned income (type=income)', () => {
    it('creates a planned income item', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test: Bonus payment',
          amount: 5000,
          scheduled_date: futureDate(30),
          type: 'income'
        })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, 'Test: Bonus payment');
      assert.equal(Number(data.amount), 5000);
      assert.equal(data.type, 'income');
      assert.ok(data.id);
      createdIncomeId = data.id;
    });

    it('rejects invalid type value', async () => {
      const res = await req('api/cash-flow/planned-expenses', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test: Bad type', amount: 100, scheduled_date: futureDate(), type: 'gift' })
      });
      assert.equal(res.status, 400);
    });

    it('lists income item with correct type', async () => {
      const res = await req('api/cash-flow/planned-expenses');
      assert.equal(res.status, 200);
      const data = await res.json();
      const item = data.planned_expenses.find(pe => pe.id === createdIncomeId);
      assert.ok(item, 'Created income item should appear in list');
      assert.equal(item.type, 'income');
    });

    it('forecast monthly outlook includes planned_income_total when income exists', async () => {
      await pool.query('DELETE FROM cash_flow_snapshots');
      const res = await req('api/cash-flow/forecast');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.monthly_outlook));
      const targetMonth = futureDate(30).slice(0, 7);
      const incomeMonth = data.monthly_outlook.find(m => m.month && m.month.startsWith(targetMonth));
      assert.ok(incomeMonth, `Expected a ${targetMonth} monthly outlook entry`);
      assert.ok(incomeMonth.planned_income_total > 0, 'planned_income_total should be > 0 for the month with income');
    });

    it('can update type via PATCH', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdIncomeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'expense' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.type, 'expense');

      // Restore to income for cleanup
      await req(`api/cash-flow/planned-expenses/${createdIncomeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'income' })
      });
    });

    it('rejects invalid type on PATCH', async () => {
      const res = await req(`api/cash-flow/planned-expenses/${createdIncomeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ type: 'surprise' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /type must be expense or income/);
    });
  });
});
