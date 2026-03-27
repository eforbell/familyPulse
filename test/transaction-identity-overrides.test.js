'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { app } = require('../server');
const { upsertTransaction } = require('../lib/sync');
const {
  isCheckLikeRawSourceText
} = require('../lib/merchant-rename-rules');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let server;
let baseUrl;
let parentSessionToken;
let kidSessionToken;
let parentId;
let kidId;
let accountId;
let txId;

function parentReq(pathname, opts = {}) {
  const headers = {
    Cookie: `fp_session=${parentSessionToken}`,
    ...opts.headers
  };
  if (!(opts.body instanceof FormData) && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers
  });
}

function kidReq(pathname, opts = {}) {
  const headers = {
    Cookie: `fp_session=${kidSessionToken}`,
    ...opts.headers
  };
  if (!(opts.body instanceof FormData) && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers
  });
}

describe('transaction identity overrides', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await pool.query(await fs.readFile(path.join(__dirname, '..', 'db', 'migrations', '017-transaction-memory.sql'), 'utf8'));
    await pool.query(await fs.readFile(path.join(__dirname, '..', 'db', 'migrations', '018-transaction-identity-overrides.sql'), 'utf8'));

    const { rows: parents } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1"
    );
    const { rows: kids } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'kid' ORDER BY id LIMIT 1"
    );
    parentId = parents[0].id;
    kidId = kids[0].id;

    parentSessionToken = crypto.randomUUID();
    kidSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3), ($4, $5, $6)',
      [parentSessionToken, parentId, expiresAt, kidSessionToken, kidId, expiresAt]
    );

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-identity', 'test-item-identity', 'ins_identity', 'Identity Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);

    const { rows: [account] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-identity-parent', $1, 'Identity Checking', 'depository', 'checking', '3333', 2000.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [item.id]);
    accountId = account.id;

    const { rows: [tx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-identity-parent', $1, 52.19, '2026-03-24', 'Crateandbar', 'CRATEANDBAR 00482', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING id
    `, [accountId]);
    txId = tx.id;
  });

  after(async () => {
    await pool.query('DELETE FROM sessions WHERE token IN ($1, $2)', [parentSessionToken, kidSessionToken]);
    await pool.query("DELETE FROM merchant_rename_rules WHERE raw_source_text IN ('Crateandbar', 'Check #1024')");
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id = 'tx-identity-sync-rule'");
    await pool.query("DELETE FROM transactions WHERE source = 'monarch' AND merchant_name = 'Crateandbar' AND account_id IN (SELECT id FROM accounts WHERE item_id IN (SELECT id FROM items WHERE item_id = 'monarch-import'))");
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id = 'tx-identity-parent'");
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-identity-parent'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-identity'");
    server.close();
    await pool.end();
  });

  it('GET /api/transactions returns raw and effective display names', async () => {
    const res = await parentReq('api/transactions?limit=100');
    assert.equal(res.status, 200);
    const data = await res.json();
    const tx = data.transactions.find(row => row.id === txId);
    assert.equal(tx.raw_display_name, 'Crateandbar');
    assert.equal(tx.effective_display_name, 'Crateandbar');
  });

  it('PUT /api/transactions/:id/display-name sets and clears override without mutating raw fields', async () => {
    const setRes = await parentReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: 'Crate & Barrel' })
    });
    assert.equal(setRes.status, 200);
    const setData = await setRes.json();
    assert.equal(setData.transaction.display_name_override, 'Crate & Barrel');
    assert.equal(setData.transaction.effective_display_name, 'Crate & Barrel');
    assert.equal(setData.transaction.raw_display_name, 'Crateandbar');
    assert.equal(setData.transaction.display_name_override_updated_by_name, 'Eric');

    const { rows: [stored] } = await pool.query(
      'SELECT merchant_name, name, display_name_override FROM transactions WHERE id = $1',
      [txId]
    );
    assert.equal(stored.merchant_name, 'Crateandbar');
    assert.equal(stored.name, 'CRATEANDBAR 00482');
    assert.equal(stored.display_name_override, 'Crate & Barrel');

    const clearRes = await parentReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: '   ' })
    });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.transaction.display_name_override, null);
    assert.equal(clearData.transaction.effective_display_name, 'Crateandbar');
  });

  it('PUT /api/transactions/:id/display-name can create an exact-match future rename rule', async () => {
    const res = await parentReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: 'Crate & Barrel', apply_to_future: true })
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.transaction.display_name_override, 'Crate & Barrel');
    assert.equal(data.transaction.rename_rule.display_name, 'Crate & Barrel');
    assert.equal(data.transaction.rename_rule.raw_source_text, 'Crateandbar');

    const { rows: [rule] } = await pool.query(
      'SELECT raw_source_text, display_name, enabled, match_type FROM merchant_rename_rules WHERE raw_source_text = $1',
      ['Crateandbar']
    );
    assert.equal(rule.raw_source_text, 'Crateandbar');
    assert.equal(rule.display_name, 'Crate & Barrel');
    assert.equal(rule.enabled, true);
    assert.equal(rule.match_type, 'exact');
  });

  it('exact-match future rename rules apply during Plaid sync upserts without mutating raw fields', async () => {
    await pool.query(
      `INSERT INTO merchant_rename_rules (raw_source_text, display_name, match_type, enabled, created_by)
       VALUES ('Crateandbar', 'Crate & Barrel', 'exact', true, $1)
       ON CONFLICT (raw_source_text) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = true, updated_at = now()`,
      [parentId]
    );

    await upsertTransaction(null, {
      transaction_id: 'tx-identity-sync-rule',
      account_id: 'acct-identity-parent',
      amount: 18.45,
      date: '2026-03-25',
      authorized_date: '2026-03-25',
      merchant_name: 'Crateandbar',
      name: 'CRATEANDBAR 00999',
      pending: false,
      iso_currency_code: 'USD'
    });

    const { rows: [stored] } = await pool.query(
      `SELECT merchant_name, name, display_name_override
       FROM transactions
       WHERE plaid_transaction_id = 'tx-identity-sync-rule'`
    );
    assert.equal(stored.merchant_name, 'Crateandbar');
    assert.equal(stored.name, 'CRATEANDBAR 00999');
    assert.equal(stored.display_name_override, 'Crate & Barrel');
  });

  it('exact-match future rename rules apply during Monarch import inserts', async () => {
    await pool.query(
      `INSERT INTO merchant_rename_rules (raw_source_text, display_name, match_type, enabled, created_by)
       VALUES ('Crateandbar', 'Crate & Barrel', 'exact', true, $1)
       ON CONFLICT (raw_source_text) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = true, updated_at = now()`,
      [parentId]
    );

    const csv = [
      'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Business Entity',
      '2026-03-26,Crateandbar,Shopping,Imported Checking (...3333),CRATEANDBAR 00482,, -52.19,,,'
    ].join('\n');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'identity-import.csv');
    form.append('categoryMap', JSON.stringify({ Shopping: '' }));
    form.append('accountMap', JSON.stringify({ 'Imported Checking (...3333)': 'auto' }));

    const res = await parentReq('api/import/commit', {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 200);

    const { rows: [stored] } = await pool.query(
      `SELECT merchant_name, name, display_name_override, source
       FROM transactions
       WHERE source = 'monarch'
         AND merchant_name = 'Crateandbar'
         AND name = 'CRATEANDBAR 00482'
       ORDER BY id DESC
       LIMIT 1`
    );
    assert.equal(stored.source, 'monarch');
    assert.equal(stored.merchant_name, 'Crateandbar');
    assert.equal(stored.name, 'CRATEANDBAR 00482');
    assert.equal(stored.display_name_override, 'Crate & Barrel');
  });

  it('search can find transactions by effective display name', async () => {
    await parentReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: 'Crate & Barrel' })
    });

    const res = await parentReq('api/transactions?search=Barrel&limit=100');
    assert.equal(res.status, 200);
    const data = await res.json();
    const tx = data.transactions.find(row => row.id === txId);
    assert.ok(tx);
    assert.equal(tx.effective_display_name, 'Crate & Barrel');
    assert.equal(tx.raw_display_name, 'Crateandbar');
  });

  it('parents can list, disable, and delete rename rules', async () => {
    await pool.query(
      `INSERT INTO merchant_rename_rules (raw_source_text, display_name, match_type, enabled, created_by)
       VALUES ('Crateandbar', 'Crate & Barrel', 'exact', true, $1)
       ON CONFLICT (raw_source_text) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = true, updated_at = now()`,
      [parentId]
    );

    const listRes = await parentReq('api/merchant-rename-rules');
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const listedRule = listData.rules.find(rule => rule.raw_source_text === 'Crateandbar');
    assert.ok(listedRule);
    assert.equal(listedRule.display_name, 'Crate & Barrel');
    assert.equal(listedRule.enabled, true);

    const disableRes = await parentReq(`api/merchant-rename-rules/${listedRule.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disableRes.status, 200);
    const disableData = await disableRes.json();
    assert.equal(disableData.rule.enabled, false);

    const deleteRes = await parentReq(`api/merchant-rename-rules/${listedRule.id}`, {
      method: 'DELETE'
    });
    assert.equal(deleteRes.status, 200);

    const { rows } = await pool.query(
      'SELECT id FROM merchant_rename_rules WHERE raw_source_text = $1',
      ['Crateandbar']
    );
    assert.equal(rows.length, 0);
  });

  it('kids cannot manage rename rules', async () => {
    const listRes = await kidReq('api/merchant-rename-rules');
    assert.equal(listRes.status, 403);

    const writeRes = await kidReq('api/merchant-rename-rules/9999', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(writeRes.status, 403);

    const deleteRes = await kidReq('api/merchant-rename-rules/9999', {
      method: 'DELETE'
    });
    assert.equal(deleteRes.status, 403);
  });

  it('check-style detection is conservative for future-rule defaults', () => {
    assert.equal(isCheckLikeRawSourceText('Check #1024'), true);
    assert.equal(isCheckLikeRawSourceText('Check 1024'), true);
    assert.equal(isCheckLikeRawSourceText('Crateandbar'), false);
    assert.equal(isCheckLikeRawSourceText('Checkbook Store'), false);
  });

  it('kid can read effective names but cannot write overrides', async () => {
    await parentReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: 'Crate & Barrel' })
    });

    const { rows: [kidAccount] } = await pool.query(
      'SELECT id FROM accounts WHERE id = $1',
      [accountId]
    );
    await pool.query(
      'INSERT INTO account_members (account_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [kidAccount.id, kidId]
    );

    const readRes = await kidReq(`api/transactions/${txId}`);
    assert.equal(readRes.status, 200);
    const readData = await readRes.json();
    assert.equal(readData.transaction.effective_display_name, 'Crate & Barrel');

    const writeRes = await kidReq(`api/transactions/${txId}/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ display_name: 'Nope' })
    });
    assert.equal(writeRes.status, 403);

    await pool.query('DELETE FROM account_members WHERE account_id = $1 AND member_id = $2', [accountId, kidId]);
  });
});
