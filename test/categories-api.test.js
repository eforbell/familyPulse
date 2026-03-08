'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Cleanup test categories
  await pool.query("DELETE FROM category_rules WHERE created_by = 'api-test'");
  await pool.query("DELETE FROM categories WHERE name LIKE 'Test Cat%'");
  server.close();
  const { pool: dbPool } = require('../lib/db');
  await dbPool.end();
  await pool.end();
});

describe('GET /api/categories', () => {
  it('returns categories with transaction counts', async () => {
    const res = await fetch(`${baseUrl}/api/categories`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);
    assert.ok('transaction_count' in data[0]);
  });
});

describe('POST /api/categories', () => {
  it('creates a new category', async () => {
    const res = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Cat Alpha', color: '#ff0000', icon: '🧪' })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'Test Cat Alpha');
    assert.equal(data.color, '#ff0000');
  });

  it('rejects duplicate name', async () => {
    const res = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Cat Alpha', color: '#00ff00' })
    });
    assert.equal(res.status, 409);
  });

  it('rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#00ff00' })
    });
    assert.equal(res.status, 400);
  });
});

describe('PUT /api/categories/:id', () => {
  it('updates a category', async () => {
    // Find our test category
    const listRes = await fetch(`${baseUrl}/api/categories`);
    const cats = await listRes.json();
    const cat = cats.find(c => c.name === 'Test Cat Alpha');

    const res = await fetch(`${baseUrl}/api/categories/${cat.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Cat Alpha Updated', color: '#0000ff' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'Test Cat Alpha Updated');
    assert.equal(data.color, '#0000ff');
  });
});

describe('DELETE /api/categories/:id', () => {
  it('deletes a category with no transactions', async () => {
    // Create a throwaway category
    const createRes = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Cat Deletable' })
    });
    const cat = await createRes.json();

    const res = await fetch(`${baseUrl}/api/categories/${cat.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  it('returns 409 when transactions are assigned', async () => {
    // Find a category that has transactions (from seed)
    const listRes = await fetch(`${baseUrl}/api/categories`);
    const cats = await listRes.json();
    const catWithTx = cats.find(c => c.transaction_count > 0);

    if (catWithTx) {
      const res = await fetch(`${baseUrl}/api/categories/${catWithTx.id}`, { method: 'DELETE' });
      assert.equal(res.status, 409);
    }
  });
});

describe('Rules API', () => {
  let ruleId;

  it('GET /api/rules returns array', async () => {
    const res = await fetch(`${baseUrl}/api/rules`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  it('POST /api/rules creates a rule', async () => {
    const catRes = await fetch(`${baseUrl}/api/categories`);
    const cats = await catRes.json();
    const catId = cats.find(c => !c.is_transfer_class)?.id;

    const res = await fetch(`${baseUrl}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_pattern: 'test-api-pattern',
        category_id: catId,
        match_type: 'contains'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    ruleId = data.id;
    assert.equal(data.merchant_pattern, 'test-api-pattern');
  });

  it('DELETE /api/rules/:id deletes a rule', async () => {
    if (!ruleId) return;
    const res = await fetch(`${baseUrl}/api/rules/${ruleId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });

  it('POST /api/rules/preview returns matches', async () => {
    const res = await fetch(`${baseUrl}/api/rules/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'xyznonexistent', match_type: 'contains' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.matches));
    assert.equal(data.count, 0);
  });

  it('POST /api/rules/apply returns result', async () => {
    const res = await fetch(`${baseUrl}/api/rules/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.matched === 'number');
    assert.ok(typeof data.total === 'number');
  });
});
