'use strict';

// Bug #168: the category decides whether a transaction is a transfer.
// Assigning a category also applies that category's transfer flag, whichever
// path assigned it, and transfer detection leaves a person's choice alone.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { app } = require('../server');
const { categorizeMany } = require('../lib/categorization');
const { detectTransfers } = require('../lib/transfer-detection');
const { getCashFlowSankey, householdToday } = require('../lib/reports');
const { transferTypeForCategory } = require('../lib/transaction-allocations');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const today = householdToday();
let server;
let baseUrl;
let sessionToken;
let checkingId;
let savingsId;
const cat = {};

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${sessionToken}`,
      ...(options.headers || {})
    }
  });
  return { response, body: await response.json() };
}

async function insertTx(key, { accountId = checkingId, amount, name, merchant = null, isTransfer = false, transferType = null }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO transactions
       (plaid_transaction_id, account_id, amount, date, name, merchant_name, pending, is_transfer, transfer_type, source)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, 'plaid')
     RETURNING id`,
    [`tx-flagcat-${key}`, accountId, amount, today, name, merchant, isTransfer, transferType]
  );
  return row.id;
}

async function flags(id) {
  const { rows: [row] } = await pool.query(
    `SELECT t.is_transfer, t.transfer_type, t.transfer_pair_id, ta.category_id
     FROM transactions t
     JOIN transaction_allocations ta ON ta.transaction_id = t.id
     WHERE t.id = $1`,
    [id]
  );
  return row;
}

async function putCategory(id, categoryId) {
  const { response, body } = await jsonRequest(`/api/transactions/${id}/category`, {
    method: 'PUT',
    body: JSON.stringify({ category_id: categoryId })
  });
  assert.equal(response.status, 200, JSON.stringify(body));
}

async function sankeyLeaf(categoryId) {
  const graph = await getCashFlowSankey('this_month', { today, maxLeaves: 500 });
  const node = graph.nodes.find(n => n.id === `out:${categoryId}`);
  return node ? node.value : 0;
}

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { rows: [parent] } = await pool.query("SELECT id FROM family_members WHERE role = 'parent' LIMIT 1");
  sessionToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [sessionToken, parent.id]
  );
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_name, status)
    VALUES ('flagcat-token', 'flagcat-item', 'Flag Test Bank', 'good')
    RETURNING id
  `);
  const { rows: [checking] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype)
    VALUES ('flagcat-checking', $1, 'Flag Checking', 'depository', 'checking') RETURNING id
  `, [item.id]);
  const { rows: [savings] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype)
    VALUES ('flagcat-savings', $1, 'Flag Savings', 'depository', 'savings') RETURNING id
  `, [item.id]);
  checkingId = checking.id;
  savingsId = savings.id;

  for (const [key, name, isTransferClass] of [
    ['groceries', 'FlagTest Groceries', false],
    ['college', 'FlagTest 529 Contribution', true],
    ['crypto', 'FlagTest Crypto/BTC', true],
    ['card', 'FlagTest CC Payment', true],
    ['transfer', 'FlagTest Transfer', true]
  ]) {
    const { rows: [row] } = await pool.query(
      'INSERT INTO categories (name, color, is_transfer_class) VALUES ($1, $2, $3) RETURNING id',
      [name, '#64748b', isTransferClass]
    );
    cat[key] = row.id;
  }
});

after(async () => {
  await pool.query("DELETE FROM category_rules WHERE merchant_pattern LIKE 'flagtest%'");
  await pool.query("DELETE FROM items WHERE item_id = 'flagcat-item'");
  await pool.query("DELETE FROM learned_category_rules WHERE category_id = ANY($1::int[])", [Object.values(cat)]);
  await pool.query("DELETE FROM categories WHERE name LIKE 'FlagTest %'");
  await pool.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
  server.close();
  await pool.end();
});

describe('transfer flag follows the category (#168)', () => {
  it('derives a transfer type from the category name', () => {
    assert.equal(transferTypeForCategory('529 Contribution'), '529_contribution');
    assert.equal(transferTypeForCategory('Crypto/BTC'), 'crypto_savings');
    assert.equal(transferTypeForCategory('CC Payment'), 'cc_payment');
    assert.equal(transferTypeForCategory('Transfer'), 'categorized_transfer');
  });

  it('a manual 529 assignment flags the payment and takes it out of the Sankey', async () => {
    // The production state from the ticket: in the 529 category, never flagged.
    const id = await insertTx('college-hist', { amount: 450.00, name: 'FLAGTEST EDU PLAN DEBIT' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [id]);
      await client.query(
        'INSERT INTO transaction_allocations (transaction_id, category_id, amount, position) VALUES ($1, $2, 450.00, 1)',
        [id, cat.college]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    assert.equal(await sankeyLeaf(cat.college), 450);

    await putCategory(id, cat.college);
    const row = await flags(id);
    assert.equal(row.is_transfer, true);
    assert.equal(row.transfer_type, '529_contribution');
    assert.equal(await sankeyLeaf(cat.college), 0);

    await putCategory(id, cat.groceries);
    const back = await flags(id);
    assert.equal(back.is_transfer, false);
    assert.equal(back.transfer_type, null);
    assert.equal(back.category_id, cat.groceries);
  });

  it('bulk categorization applies the flag to every row', async () => {
    const a = await insertTx('card-a', { amount: 311.17, name: 'FLAGTEST BANK PMT A' });
    const b = await insertTx('card-b', { amount: 311.18, name: 'FLAGTEST BANK PMT B' });
    const { response } = await jsonRequest('/api/transactions/bulk-categorize', {
      method: 'POST',
      body: JSON.stringify({ transaction_ids: [a, b], category_id: cat.card })
    });
    assert.equal(response.status, 200);
    for (const id of [a, b]) {
      const row = await flags(id);
      assert.equal(row.is_transfer, true);
      assert.equal(row.transfer_type, 'cc_payment');
    }
  });

  it('assigning Uncategorized clears the flag', async () => {
    const id = await insertTx('uncat', {
      amount: 222.19, name: 'FLAGTEST MYSTERY', isTransfer: true, transferType: 'cc_payment'
    });
    await putCategory(id, null);
    const row = await flags(id);
    assert.equal(row.is_transfer, false);
    assert.equal(row.transfer_type, null);
  });

  it('keeps a detected pair when it stays a transfer, and unlinks both legs when it leaves', async () => {
    const out = await insertTx('pair-out', { amount: 613.29, name: 'FLAGTEST TO SAVINGS' });
    const into = await insertTx('pair-in', { accountId: savingsId, amount: -613.29, name: 'FLAGTEST FROM CHECKING' });
    await pool.query(
      `UPDATE transactions SET is_transfer = true, transfer_type = 'inter_account',
         transfer_pair_id = CASE WHEN id = $1 THEN $2 ELSE $1 END
       WHERE id IN ($1, $2)`,
      [out, into]
    );

    await putCategory(out, cat.transfer);
    let row = await flags(out);
    assert.equal(row.is_transfer, true);
    assert.equal(row.transfer_type, 'inter_account');
    assert.equal(row.transfer_pair_id, into);

    await putCategory(out, cat.groceries);
    row = await flags(out);
    assert.equal(row.is_transfer, false);
    assert.equal(row.transfer_pair_id, null);
    const partner = await flags(into);
    assert.equal(partner.is_transfer, true, 'the other leg is still money arriving from elsewhere');
    assert.equal(partner.transfer_pair_id, null);
  });

  it('a rule matching merchant_name exactly categorizes and flags in one step', async () => {
    // The ticket's mismatch: distinct name and merchant_name, exact rule on one of them.
    await pool.query(
      `INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by)
       VALUES ('flagtest btc exchange', $1, 'exact', 'test')`,
      [cat.crypto]
    );
    const id = await insertTx('rule-exact', {
      amount: 97.31, name: 'FLAGTEST ACH DEBIT 0042', merchant: 'FlagTest BTC Exchange'
    });
    await categorizeMany();
    const row = await flags(id);
    assert.equal(row.category_id, cat.crypto);
    assert.equal(row.is_transfer, true);
    assert.equal(row.transfer_type, 'crypto_savings');
  });

  it('transfer detection does not re-flag a transaction someone categorized', async () => {
    const control = await insertTx('detect-control', { amount: 41.07, name: 'Coinbase FLAGTEST control' });
    const groceries = await insertTx('detect-groceries', { amount: 41.08, name: 'Coinbase FLAGTEST groceries' });
    const cleared = await insertTx('detect-cleared', { amount: 41.09, name: 'Coinbase FLAGTEST cleared' });
    await putCategory(groceries, cat.groceries);
    await putCategory(cleared, null);

    await detectTransfers(7);

    assert.equal((await flags(control)).is_transfer, true, 'the detector still runs on uncategorized rows');
    assert.equal((await flags(groceries)).is_transfer, false);
    assert.equal((await flags(cleared)).is_transfer, false);
  });
});

describe('concurrent category changes', () => {
  it('recategorizing both legs of a pair at once never deadlocks', async () => {
    for (let i = 0; i < 25; i++) {
      const out = await insertTx(`race-out-${i}`, { amount: 800 + i, name: `FLAGTEST RACE OUT ${i}` });
      const into = await insertTx(`race-in-${i}`, { accountId: savingsId, amount: -(800 + i), name: `FLAGTEST RACE IN ${i}` });
      await pool.query(
        `UPDATE transactions SET is_transfer = true, transfer_type = 'inter_account',
           transfer_pair_id = CASE WHEN id = $1 THEN $2 ELSE $1 END
         WHERE id IN ($1, $2)`,
        [out, into]
      );
      const results = await Promise.all([out, into].map(id => jsonRequest(`/api/transactions/${id}/category`, {
        method: 'PUT',
        body: JSON.stringify({ category_id: cat.groceries })
      })));
      for (const { response, body } of results) {
        assert.equal(response.status, 200, JSON.stringify(body));
      }
    }
  });

  it('detection does not flag a transaction whose manual edit commits while it waits', async () => {
    const id = await insertTx('detect-race', { amount: 57.13, name: 'Coinbase FLAGTEST race' });
    const { setSingleTransactionCategory } = require('../lib/transaction-allocations');
    const editor = await pool.connect();
    let detection;
    try {
      await editor.query('BEGIN');
      await setSingleTransactionCategory(editor, {
        transactionId: id, categoryId: cat.groceries, categorizationSource: 'manual'
      });
      // Detection reads the row as an uncategorized Coinbase purchase, then
      // queues behind the editor's lock.
      detection = detectTransfers(7);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const { rows: [row] } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        waiting = row.n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(waiting, 'detection should be waiting on the edited row');
      await editor.query('COMMIT');
    } finally {
      editor.release();
    }
    await detection;
    const row = await flags(id);
    assert.equal(row.category_id, cat.groceries);
    assert.equal(row.is_transfer, false);
  });
});
