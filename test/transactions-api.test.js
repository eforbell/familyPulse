'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Start a real server for HTTP testing
const { app } = require('../server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Seed test data
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-api', 'test-item-api', 'ins_api', 'Test Bank API', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);

  const { rows: [acct] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
    VALUES ('acct-api-test', $1, 'API Checking', 'depository', 'checking', '9999', 5000, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'API Checking'
    RETURNING id
  `, [item.id]);

  // Seed some transactions
  for (let i = 1; i <= 5; i++) {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'test')
      ON CONFLICT (plaid_transaction_id) DO NOTHING
    `, [
      `tx-api-${i}`, acct.id,
      i === 3 ? -100 : i * 10,
      `2026-03-0${i}`,
      i === 1 ? 'Coffee Shop' : i === 2 ? 'Grocery Store' : i === 3 ? 'Employer Inc' : `Merchant ${i}`,
      `Transaction ${i}`,
      i === 5
    ]);
  }

  // Add a transfer transaction
  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_transfer, transfer_type, source)
    VALUES ('tx-api-transfer', $1, 200, '2026-03-01', 'Transfer Out', false, true, 'inter_account', 'test')
    ON CONFLICT (plaid_transaction_id) DO NOTHING
  `, [acct.id]);
});

after(async () => {
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'tx-api-%'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-api-test'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-api'");
  server.close();
  const { pool: dbPool } = require('../lib/db');
  await dbPool.end();
  await pool.end();
});

describe('GET /api/transactions', () => {
  it('returns transactions with total and sum', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?limit=10`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.transactions));
    assert.ok(typeof data.total === 'number');
    assert.ok(typeof data.sum === 'number');
  });

  it('hides transfers by default', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?limit=100`);
    const data = await res.json();
    const hasTransfer = data.transactions.some(t => t.is_transfer);
    assert.equal(hasTransfer, false, 'Should not include transfers by default');
  });

  it('shows transfers when show_transfers=1', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?show_transfers=1&limit=100`);
    const data = await res.json();
    const hasTransfer = data.transactions.some(t => t.is_transfer);
    assert.equal(hasTransfer, true, 'Should include transfers when requested');
  });

  it('filters by search', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?search=Coffee&limit=10`);
    const data = await res.json();
    assert.ok(data.transactions.length > 0);
    assert.ok(data.transactions.every(t =>
      (t.merchant_name || '').toLowerCase().includes('coffee') ||
      (t.name || '').toLowerCase().includes('coffee')
    ));
  });

  it('filters uncategorized with category_id=0', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?category_id=0&limit=10`);
    const data = await res.json();
    assert.ok(data.transactions.every(t => t.category_id === null));
  });

  it('respects pagination', async () => {
    const res1 = await fetch(`${baseUrl}/api/transactions?limit=2&offset=0`);
    const data1 = await res1.json();
    assert.equal(data1.transactions.length, 2);

    const res2 = await fetch(`${baseUrl}/api/transactions?limit=2&offset=2`);
    const data2 = await res2.json();
    assert.ok(data1.transactions[0].id !== data2.transactions[0].id);
  });
});

describe('PUT /api/transactions/:id/category', () => {
  it('assigns a category', async () => {
    // Get a transaction ID
    const listRes = await fetch(`${baseUrl}/api/transactions?search=Coffee&limit=1`);
    const listData = await listRes.json();
    const txId = listData.transactions[0].id;

    // Get a category ID
    const catRes = await fetch(`${baseUrl}/api/categories`);
    const cats = await catRes.json();
    const catId = cats[0].id;

    const res = await fetch(`${baseUrl}/api/transactions/${txId}/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: catId })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  });

  it('returns 404 for non-existent transaction', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/999999/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: 1 })
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/transactions/bulk-categorize', () => {
  it('assigns category to multiple transactions', async () => {
    const listRes = await fetch(`${baseUrl}/api/transactions?limit=3`);
    const listData = await listRes.json();
    const ids = listData.transactions.map(t => t.id);

    const catRes = await fetch(`${baseUrl}/api/categories`);
    const cats = await catRes.json();

    const res = await fetch(`${baseUrl}/api/transactions/bulk-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: ids, category_id: cats[0].id })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.updated > 0);
  });

  it('rejects empty array', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/bulk-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: [], category_id: 1 })
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/accounts/dashboard', () => {
  it('returns grouped accounts with totals', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/dashboard`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.groups);
    assert.ok(typeof data.liquid_total === 'number');
    assert.ok(typeof data.credit_total === 'number');
    assert.ok(typeof data.net_position === 'number');
  });
});

describe('GET /api/family-members', () => {
  it('returns family members', async () => {
    const res = await fetch(`${baseUrl}/api/family-members`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 4);
    assert.ok(data.some(m => m.name === 'Eric'));
  });
});
