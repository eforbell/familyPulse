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
let uncategorizedTransferTxId;

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

  const { rows: [uncategorizedTransferTx] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, transfer_type, source, category_id)
    VALUES ('tx-api-uncat-transfer', $1, 250.00, '2026-03-07', 'Mystery Transfer', 'Mystery Transfer', false, true, 'cc_payment', 'test', NULL)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET is_transfer = EXCLUDED.is_transfer, transfer_type = EXCLUDED.transfer_type, category_id = EXCLUDED.category_id
    RETURNING id
  `, [acct.id]);
  uncategorizedTransferTxId = uncategorizedTransferTx.id;

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

  const splitDedupClient = await pool.connect();
  try {
    await splitDedupClient.query('BEGIN');
    await splitDedupClient.query(
      'UPDATE transactions SET category_id = NULL WHERE id = $1',
      [dedupImportTxId]
    );
    await splitDedupClient.query(
      'DELETE FROM transaction_allocations WHERE transaction_id = $1',
      [dedupImportTxId]
    );
    await splitDedupClient.query(
      `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
       VALUES ($1, $2, 30.00, 1), ($1, $3, 10.00, 2), ($1, NULL, 2.10, 3)`,
      [dedupImportTxId, assignCategoryId, uncategorizedCategoryId]
    );
    await splitDedupClient.query('COMMIT');
  } catch (err) {
    await splitDedupClient.query('ROLLBACK');
    throw err;
  } finally {
    splitDedupClient.release();
  }

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
  await pool.query("DELETE FROM category_rules WHERE merchant_pattern LIKE 'Rule Merchant %'");
  await pool.query("DELETE FROM dedup_runs WHERE created_by = 'test-runner'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-api-test'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-api'");
  server.close();
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

  it('sorts by amount descending when requested', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?sort_field=amount&sort_direction=desc&limit=20`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.transactions.length > 1);
    for (let i = 1; i < data.transactions.length; i++) {
      const prev = Math.abs(Number(data.transactions[i - 1].amount));
      const next = Math.abs(Number(data.transactions[i].amount));
      assert.ok(prev >= next, `expected ${prev} >= ${next}`);
    }
  });

  it('sorts by amount ascending when requested', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?sort_field=amount&sort_direction=asc&limit=20`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.transactions.length > 1);
    for (let i = 1; i < data.transactions.length; i++) {
      const prev = Math.abs(Number(data.transactions[i - 1].amount));
      const next = Math.abs(Number(data.transactions[i].amount));
      assert.ok(prev <= next, `expected ${prev} <= ${next}`);
    }
  });

  it('filters by minimum amount using absolute value', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?account_id=${accountId}&amount_min=50&limit=100`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = data.transactions.map(t => t.plaid_transaction_id);
    assert.ok(data.transactions.every(t => Math.abs(Number(t.amount)) >= 50));
    assert.ok(ids.includes('tx-api-3'), 'negative -100 should match on magnitude');
    assert.ok(ids.includes('tx-api-5'));
    assert.ok(!ids.includes('tx-api-1'));
  });

  it('filters by maximum amount and supports a range', async () => {
    const maxRes = await fetch(`${baseUrl}/api/transactions?account_id=${accountId}&amount_max=20&limit=100`);
    const maxData = await maxRes.json();
    assert.ok(maxData.transactions.every(t => Math.abs(Number(t.amount)) <= 20));
    assert.ok(maxData.transactions.some(t => t.plaid_transaction_id === 'tx-api-1'));
    assert.ok(!maxData.transactions.some(t => t.plaid_transaction_id === 'tx-api-3'));

    const rangeRes = await fetch(`${baseUrl}/api/transactions?account_id=${accountId}&amount_min=15&amount_max=45&limit=100`);
    const rangeData = await rangeRes.json();
    assert.ok(rangeData.transactions.every(t => {
      const a = Math.abs(Number(t.amount));
      return a >= 15 && a <= 45;
    }));
    assert.ok(rangeData.transactions.some(t => t.plaid_transaction_id === 'tx-api-2'));
  });

  it('ignores blank or invalid amount filters', async () => {
    const base = await (await fetch(`${baseUrl}/api/transactions?account_id=${accountId}`)).json();
    const res = await fetch(`${baseUrl}/api/transactions?account_id=${accountId}&amount_min=&amount_max=abc`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.total, base.total);
  });

  it('filters uncategorized with category_id=0', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?category_id=0&limit=50`);
    const data = await res.json();
    assert.ok(data.transactions.every(t => t.category_id === null || t.category_id === uncategorizedCategoryId));
    assert.ok(data.transactions.some(t => t.id === explicitUncategorizedTxId));
  });

  it('shows uncategorized transfer rows in uncategorized view without enabling global transfers', async () => {
    const res = await fetch(`${baseUrl}/api/transactions?category_id=0&limit=100`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const tx = data.transactions.find(t => t.id === uncategorizedTransferTxId);
    assert.ok(tx, 'expected uncategorized transfer row to be visible in uncategorized view');
    assert.equal(tx.is_transfer, true);
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
    assert.equal(plaidRow.category_id, null, 'split allocation state should be canonical');
    const { rows: plaidAllocations } = await pool.query(
      `SELECT category_id, amount::text
       FROM transaction_allocations
       WHERE transaction_id = $1
       ORDER BY position`,
      [dedupPlaidTxId]
    );
    assert.deepEqual(plaidAllocations, [
      { category_id: assignCategoryId, amount: '30.00' },
      { category_id: uncategorizedCategoryId, amount: '10.00' },
      { category_id: null, amount: '2.10' }
    ], 'dedup should preserve every balancing allocation row');

    await pool.query(
      `UPDATE dedup_runs SET created_by = 'test-runner' WHERE id = $1`,
      [hiddenRows[0].dedup_run_id]
    );
  });

  it('keeps a split import visible while its Plaid match is pending', async () => {
    const { rows: [pendingPlaid] } = await pool.query(`
      INSERT INTO transactions
        (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-api-dedup-pending-plaid', $1, 43.21, '2026-04-10', 'Pending Split Match', 'Pending Split Match', true, false, 'plaid')
      RETURNING id
    `, [accountId]);
    const { rows: [splitImport] } = await pool.query(`
      INSERT INTO transactions
        (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-api-dedup-pending-import', $1, 43.21, '2026-04-10', 'Pending Split Match', 'Pending Split Match', false, false, 'monarch')
      RETURNING id
    `, [accountId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [splitImport.id]);
      await client.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
         VALUES ($1, $2, 30.00, 1), ($1, $3, 13.21, 2)`,
        [splitImport.id, assignCategoryId, uncategorizedCategoryId]
      );
      await client.query('COMMIT');
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }

    const res = await fetch(`${baseUrl}/api/transactions/dedup/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: '2026-04-01', date_to: '2026-04-30' })
    });
    assert.equal(res.status, 200);

    const { rows: [importState] } = await pool.query(
      'SELECT is_hidden FROM transactions WHERE id = $1',
      [splitImport.id]
    );
    const { rows: [targetState] } = await pool.query(
      `SELECT t.pending, count(ta.*)::int AS allocation_count
       FROM transactions t
       JOIN transaction_allocations ta ON ta.transaction_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [pendingPlaid.id]
    );
    assert.equal(importState.is_hidden, false);
    assert.equal(targetState.pending, true);
    assert.equal(targetState.allocation_count, 1);
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


describe('POST /api/transactions/:id/create-rule', () => {
  it('creates a rule and applies it to matching uncategorized transactions', async () => {
    const merchant = `Rule Merchant ${Date.now()}`;
    const { rows: [seed] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ($1, $2, 19.99, '2026-03-08', $3, $3, false, false, 'test')
      RETURNING id
    `, [`tx-api-rule-seed-${Date.now()}`, accountId, merchant]);

    const { rows: [futureMatch] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
      VALUES ($1, $2, 29.99, '2026-03-09', $3, $3, false, false, 'test', NULL)
      RETURNING id
    `, [`tx-api-rule-future-${Date.now()}`, accountId, merchant]);
    const { rows: [pendingMatch] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source, category_id)
      VALUES ($1, $2, 39.99, '2026-03-10', $3, $3, true, false, 'test', NULL)
      RETURNING id
    `, [`tx-api-rule-pending-${Date.now()}`, accountId, merchant]);

    const res = await fetch(`${baseUrl}/api/transactions/${seed.id}/create-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: assignCategoryId })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.rule.category_id, assignCategoryId);

    const { rows: [updated] } = await pool.query(
      'SELECT category_id FROM transactions WHERE id = $1',
      [futureMatch.id]
    );
    assert.equal(updated.category_id, assignCategoryId);

    const { rows: [pending] } = await pool.query(
      'SELECT category_id FROM transactions WHERE id = $1',
      [pendingMatch.id]
    );
    assert.equal(pending.category_id, null);
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
