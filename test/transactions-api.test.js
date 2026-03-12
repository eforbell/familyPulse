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
let accountId;
let assignCategoryId;
let familyMemberCount;
let coffeeTransactionId;
let bulkTransactionIds;
let dedupPlaidTxId;
let dedupImportTxId;
let dedupImportTxId2;
let dedupHiddenImportTxId;
let uncategorizedCategoryId;
let explicitUncategorizedTxId;

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
  accountId = acct.id;

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

  const { rows: [category] } = await pool.query(
    `SELECT id FROM categories WHERE name = 'Groceries'`
  );
  assignCategoryId = category.id;

  const { rows: [uncategorizedCategory] } = await pool.query(
    `SELECT id FROM categories WHERE name = 'Uncategorized'`
  );
  uncategorizedCategoryId = uncategorizedCategory.id;

  const { rows: [explicitUncategorizedTx] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
    VALUES ('tx-api-uncat-explicit', $1, 18.75, '2026-03-06', 'Unknown Merchant', 'Unknown Merchant', false, false, 'test', $2)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET category_id = EXCLUDED.category_id
    RETURNING id
  `, [acct.id, uncategorizedCategoryId]);
  explicitUncategorizedTxId = explicitUncategorizedTx.id;

  const { rows: [coffeeTx] } = await pool.query(
    `SELECT id FROM transactions WHERE plaid_transaction_id = 'tx-api-1'`
  );
  coffeeTransactionId = coffeeTx.id;

  const { rows } = await pool.query(`
    SELECT id
    FROM transactions
    WHERE plaid_transaction_id IN ('tx-api-1', 'tx-api-2', 'tx-api-3')
    ORDER BY plaid_transaction_id
  `);
  bulkTransactionIds = rows.map(row => row.id);

  const { rows: [plaidDup] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
    VALUES ('tx-api-dedup-plaid', $1, 42.10, '2026-02-10', 'Coffee Shop', 'Coffee Shop', false, false, 'plaid', NULL)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
    RETURNING id
  `, [acct.id]);
  dedupPlaidTxId = plaidDup.id;

  const { rows: [importDup] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
    VALUES ('tx-api-dedup-import', $1, 42.10, '2026-02-11', 'Coffee Shop', 'Coffee Shop', false, false, 'monarch', $2)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
    RETURNING id
  `, [acct.id, assignCategoryId]);
  dedupImportTxId = importDup.id;

  const { rows: [importDup2] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
    VALUES ('tx-api-dedup-import-2', $1, 42.10, '2026-02-11', 'Coffee Shop', 'Coffee Shop', false, false, 'monarch', $2)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
    RETURNING id
  `, [acct.id, assignCategoryId]);
  dedupImportTxId2 = importDup2.id;

  const { rows: [familyStats] } = await pool.query(
    'SELECT count(*)::int AS count FROM family_members'
  );
  familyMemberCount = familyStats.count;
});

after(async () => {
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'tx-api-%'");
  await pool.query("DELETE FROM dedup_runs WHERE created_by = 'test-runner'");
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
    const res = await fetch(`${baseUrl}/api/transactions?category_id=0&limit=50`);
    const data = await res.json();
    assert.ok(data.transactions.every(t => t.category_id === null || t.category_id === uncategorizedCategoryId));
    assert.ok(data.transactions.some(t => t.id === explicitUncategorizedTxId));
  });

  it('respects pagination', async () => {
    const res1 = await fetch(`${baseUrl}/api/transactions?limit=2&offset=0`);
    const data1 = await res1.json();
    assert.equal(data1.transactions.length, 2);

    const res2 = await fetch(`${baseUrl}/api/transactions?limit=2&offset=2`);
    const data2 = await res2.json();
    assert.ok(data1.transactions[0].id !== data2.transactions[0].id);
  });

  it('hides suppressed transactions by default and shows when show_hidden=1', async () => {
    await pool.query(
      `UPDATE transactions SET is_hidden = true, hidden_reason = 'test-hide' WHERE id = $1`,
      [dedupImportTxId]
    );

    const resDefault = await fetch(`${baseUrl}/api/transactions?limit=200`);
    const dataDefault = await resDefault.json();
    assert.equal(dataDefault.transactions.some(t => t.id === dedupImportTxId), false);

    const resShown = await fetch(`${baseUrl}/api/transactions?limit=200&show_hidden=1`);
    const dataShown = await resShown.json();
    assert.equal(dataShown.transactions.some(t => t.id === dedupImportTxId), true);

    await pool.query(
      `UPDATE transactions SET is_hidden = false, hidden_reason = NULL WHERE id = $1`,
      [dedupImportTxId]
    );
  });
});

describe('Dedup endpoints', () => {
  it('previews duplicates between plaid and imported rows', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/dedup/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-02-01', date_to: '2026-02-28' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.duplicates_found === 'number');
    assert.ok(data.duplicates_found >= 1);
  });

  it('applies dedup by hiding imported tx and preserving plaid tx', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/dedup/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-02-01', date_to: '2026-02-28' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.hidden >= 1);

    const { rows: importRows } = await pool.query(
      `SELECT id, is_hidden, hidden_reason, duplicate_of_transaction_id, dedup_run_id
       FROM transactions
       WHERE id = ANY($1::int[])
       ORDER BY id`,
      [[dedupImportTxId, dedupImportTxId2]]
    );
    const hiddenRows = importRows.filter(r => r.is_hidden);
    const visibleRows = importRows.filter(r => !r.is_hidden);
    assert.equal(hiddenRows.length, 1, 'Only one imported txn should match a single Plaid txn');
    assert.equal(visibleRows.length, 1, 'Second imported txn should remain visible');
    assert.equal(hiddenRows[0].hidden_reason, 'duplicate_prefer_plaid');
    assert.equal(hiddenRows[0].duplicate_of_transaction_id, dedupPlaidTxId);
    assert.ok(hiddenRows[0].dedup_run_id);
    dedupHiddenImportTxId = hiddenRows[0].id;

    const { rows: [plaidRow] } = await pool.query(
      `SELECT is_hidden, category_id FROM transactions WHERE id = $1`,
      [dedupPlaidTxId]
    );
    assert.equal(plaidRow.is_hidden, false);
    assert.equal(plaidRow.category_id, assignCategoryId, 'should copy category from imported row when plaid is uncategorized');

    await pool.query(
      `UPDATE dedup_runs SET created_by = 'test-runner' WHERE id = $1`,
      [hiddenRows[0].dedup_run_id]
    );
  });

  it('unhide clears dedup metadata', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/${dedupHiddenImportTxId}/unhide`, {
      method: 'PUT'
    });
    assert.equal(res.status, 200);

    const { rows: [row] } = await pool.query(
      `SELECT is_hidden, hidden_reason, duplicate_of_transaction_id, dedup_run_id
       FROM transactions WHERE id = $1`,
      [dedupHiddenImportTxId]
    );
    assert.equal(row.is_hidden, false);
    assert.equal(row.hidden_reason, null);
    assert.equal(row.duplicate_of_transaction_id, null);
    assert.equal(row.dedup_run_id, null);
  });

  it('lists dedup run history', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/dedup/runs?limit=5`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 1);
    assert.ok(data.some(r => Number(r.txns_hidden) >= 1));
  });
});

describe('PUT /api/transactions/:id/category', () => {
  it('assigns a category', async () => {
    const res = await fetch(`${baseUrl}/api/transactions/${coffeeTransactionId}/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: assignCategoryId })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const { rows: [updated] } = await pool.query(
      'SELECT category_id FROM transactions WHERE id = $1',
      [coffeeTransactionId]
    );
    assert.equal(updated.category_id, assignCategoryId);
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
    const res = await fetch(`${baseUrl}/api/transactions/bulk-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: bulkTransactionIds, category_id: assignCategoryId })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.updated, bulkTransactionIds.length);
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
    const res = await fetch(`${baseUrl}/api/accounts/dashboard?account_id=${accountId}`);
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
    assert.equal(data.length, familyMemberCount);
    assert.ok(data.some(m => m.name === 'Eric'));
  });
});
