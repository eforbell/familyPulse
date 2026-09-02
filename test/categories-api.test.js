'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
let server;
let baseUrl;
let protectedCategoryId;
let ruleCategoryId;

before(async () => {
  const fs = require('fs');
  const path = require('path');
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const migrationSql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '016-category-baseline-exclusion.sql'),
    'utf8'
  );
  await pool.query(migrationSql);

  const { rows: [protectedCategory] } = await pool.query(`
    INSERT INTO categories (name, color, icon)
    VALUES ('Test Cat Protected', '#334155', '🧱')
    RETURNING id
  `);
  protectedCategoryId = protectedCategory.id;

  const { rows: [ruleCategory] } = await pool.query(
    `SELECT id FROM categories WHERE name = 'Groceries'`
  );
  ruleCategoryId = ruleCategory.id;

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-categories', 'test-item-categories', 'ins_cat', 'Test Categories Bank', 'good')
    RETURNING id
  `);

  const { rows: [account] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
    VALUES ('acct-categories-test', $1, 'Categories Checking', 'depository', 'checking', '5555', 1200, 'Eric')
    RETURNING id
  `, [item.id]);

  const { rows: [protectedTransaction] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
    VALUES ('tx-categories-protected', $1, 42.50, '2026-03-02', 'Protected Merchant', 'Protected Transaction', false, false, 'test', $2)
    RETURNING id
  `, [account.id, protectedCategoryId]);

  const { rows: [splitPeer] } = await pool.query(`
    INSERT INTO categories (name, color, icon)
    VALUES ('Test Cat Split Peer', '#64748b', '🧩')
    RETURNING id
  `);
  const splitClient = await pool.connect();
  try {
    await splitClient.query('BEGIN');
    await splitClient.query('UPDATE transactions SET category_id = NULL WHERE id = $1', [protectedTransaction.id]);
    await splitClient.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [protectedTransaction.id]);
    await splitClient.query(
      `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
       VALUES ($1, $2, 20.00, 1), ($1, $3, 22.50, 2)`,
      [protectedTransaction.id, protectedCategoryId, splitPeer.id]
    );
    await splitClient.query('COMMIT');
  } finally {
    try { await splitClient.query('ROLLBACK'); } catch {}
    splitClient.release();
  }
});

after(async () => {
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id = 'tx-categories-protected'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-categories-test'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-categories'");
  await pool.query("DELETE FROM category_rules WHERE created_by = 'api-test'");
  await pool.query("DELETE FROM categories WHERE name LIKE 'Test Cat%'");
  server.close();
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
      body: JSON.stringify({ name: 'Test Cat Alpha', color: '#ff0000', icon: '🧪', exclude_from_baseline: true })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'Test Cat Alpha');
    assert.equal(data.color, '#ff0000');
    assert.equal(data.exclude_from_baseline, true);
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
      body: JSON.stringify({ name: 'Test Cat Alpha Updated', color: '#0000ff', exclude_from_baseline: false })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'Test Cat Alpha Updated');
    assert.equal(data.color, '#0000ff');
    assert.equal(data.exclude_from_baseline, false);
  });

  it('rejects a transfer-class change that would create a mixed split', async () => {
    const res = await fetch(`${baseUrl}/api/categories/${protectedCategoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_transfer_class: true })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /transfer classification conflicts/i);
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
    const res = await fetch(`${baseUrl}/api/categories/${protectedCategoryId}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
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
    const res = await fetch(`${baseUrl}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_pattern: 'test-api-pattern',
        category_id: ruleCategoryId,
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
