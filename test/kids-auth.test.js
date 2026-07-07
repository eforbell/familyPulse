'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { hashPassphrase } = require('../lib/auth');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
let server, baseUrl;

let kidMemberId, parentMemberId;
let kidSessionToken, parentSessionToken;
let kidAccountId, parentAccountId;
let kidTxId, parentTxId;

function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  return fetch(`${baseUrl}/${path}`, { ...opts, headers });
}

function kidReq(path, opts = {}) {
  return req(path, {
    ...opts,
    headers: { ...opts.headers, Cookie: `fp_session=${kidSessionToken}` }
  });
}

function parentReq(path, opts = {}) {
  return req(path, {
    ...opts,
    headers: { ...opts.headers, Cookie: `fp_session=${parentSessionToken}` }
  });
}

describe('kids authorization', () => {
  before(async () => {
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Create test family members WITHOUT passphrases to avoid enabling auth globally.
    // Session middleware still sets req.member from cookies, and requireParent
    // enforces role checks regardless of authEnabled().
    const { rows: [parent] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji)
      VALUES ('TestParent', 'parent', '🧑')
      ON CONFLICT (name) DO UPDATE SET role = 'parent'
      RETURNING id
    `);
    parentMemberId = parent.id;

    const { rows: [kid] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji)
      VALUES ('TestKid', 'kid', '🧒')
      ON CONFLICT (name) DO UPDATE SET role = 'kid'
      RETURNING id
    `);
    kidMemberId = kid.id;

    // Create sessions
    const crypto = require('crypto');
    kidSessionToken = crypto.randomUUID();
    parentSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)', [kidSessionToken, kidMemberId, expiresAt]);
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)', [parentSessionToken, parentMemberId, expiresAt]);

    // Create test item, accounts, and transactions
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-kids-auth', 'test-item-kids-auth', 'ins_kids', 'Kids Test Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);

    const { rows: [kidAcct] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
      VALUES ('acct-kid-auth', $1, 'Kid Checking', 'depository', 'checking', '1111', 200, 'TestKid')
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Kid Checking'
      RETURNING id
    `, [item.id]);
    kidAccountId = kidAcct.id;

    const { rows: [parentAcct] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
      VALUES ('acct-parent-auth', $1, 'Parent Checking', 'depository', 'checking', '2222', 10000, 'TestParent')
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Parent Checking'
      RETURNING id
    `, [item.id]);
    parentAccountId = parentAcct.id;

    // Link kid to kid account
    await pool.query(`
      INSERT INTO account_members (account_id, member_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [kidAccountId, kidMemberId]);

    // Create transactions
    const { rows: [kidTx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-kid-auth', $1, 15.00, CURRENT_DATE, 'Kid Store', 'Kid Store', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET merchant_name = 'Kid Store'
      RETURNING id
    `, [kidAccountId]);
    kidTxId = kidTx.id;

    const { rows: [parentTx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-parent-auth', $1, 100.00, CURRENT_DATE, 'Parent Store', 'Parent Store', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET merchant_name = 'Parent Store'
      RETURNING id
    `, [parentAccountId]);
    parentTxId = parentTx.id;
  });

  after(async () => {
    // Cleanup
    await pool.query("DELETE FROM sessions WHERE token IN ($1, $2)", [kidSessionToken, parentSessionToken]);
    await pool.query("DELETE FROM account_members WHERE member_id = $1", [kidMemberId]);
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id IN ('tx-kid-auth', 'tx-parent-auth')");
    await pool.query("DELETE FROM accounts WHERE plaid_account_id IN ('acct-kid-auth', 'acct-parent-auth')");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-kids-auth'");
    await pool.query("DELETE FROM family_members WHERE name IN ('TestParent', 'TestKid')");
    server.close();
    await pool.end();
  });

  // ── Kid gets 403 from parent-only routes ────────────────────

  it('kid gets 403 from /api/accounts/coverage', async () => {
    const res = await kidReq('api/accounts/coverage');
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/budget/summary', async () => {
    const res = await kidReq('api/budget/summary');
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/budget/category/1', async () => {
    const res = await kidReq('api/budget/category/1');
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/transactions/:id/create-rule', async () => {
    const res = await kidReq(`api/transactions/${kidTxId}/create-rule`, {
      method: 'POST',
      body: JSON.stringify({ category_id: 1 })
    });
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/transactions/bulk-categorize', async () => {
    const res = await kidReq('api/transactions/bulk-categorize', {
      method: 'POST',
      body: JSON.stringify({ transaction_ids: [kidTxId], category_id: 1 })
    });
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from PATCH /api/accounts/:id/name', async () => {
    const res = await kidReq(`api/accounts/${kidAccountId}/name`, {
      method: 'PATCH',
      body: JSON.stringify({ custom_name: 'Hacked' })
    });
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/status', async () => {
    const res = await kidReq('api/status');
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/family-members', async () => {
    const res = await kidReq('api/family-members');
    assert.equal(res.status, 403);
  });

  it('kid gets 403 from /api/rules', async () => {
    const res = await kidReq('api/rules');
    assert.equal(res.status, 403);
  });

  // ── Feature 24: kids cannot create learned categorization signals ──

  it('kid gets 403 when categorizing own transaction', async () => {
    // Get a valid category ID
    const catRes = await kidReq('api/categories');
    const cats = await catRes.json();
    if (cats.length === 0) return; // no categories seeded, skip

    const res = await kidReq(`api/transactions/${kidTxId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category_id: cats[0].id })
    });
    assert.equal(res.status, 403);
  });

  it('kid gets 403 when categorizing parent transaction', async () => {
    const catRes = await kidReq('api/categories');
    const cats = await catRes.json();
    if (cats.length === 0) return;

    const res = await kidReq(`api/transactions/${parentTxId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category_id: cats[0].id })
    });
    assert.equal(res.status, 403);
  });

  it('authenticated kid is redirected from root to dedicated kid route when auth is enabled', async () => {
    const passphraseHash = hashPassphrase('test-passphrase');
    await pool.query(
      'UPDATE family_members SET passphrase_hash = $1 WHERE id = $2',
      [passphraseHash, parentMemberId]
    );

    try {
      const res = await fetch(`${baseUrl}/`, {
        headers: { Cookie: `fp_session=${kidSessionToken}` },
        redirect: 'manual'
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/kids/testkid');
    } finally {
      await pool.query(
        'UPDATE family_members SET passphrase_hash = NULL WHERE id = $1',
        [parentMemberId]
      );
    }
  });
});
