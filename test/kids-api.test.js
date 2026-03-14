'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
let server, baseUrl;

let kidMemberId, parentMemberId;
let kidSessionToken, parentSessionToken;
let kidAccountId;

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

describe('kids dashboard API', () => {
  before(async () => {
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // No passphrases — avoids enabling auth globally in the shared test DB.
    // Session middleware still populates req.member from session cookies.
    const { rows: [parent] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji, monthly_budget)
      VALUES ('TestParentAPI', 'parent', '🧑', NULL)
      ON CONFLICT (name) DO UPDATE SET role = 'parent', monthly_budget = NULL
      RETURNING id
    `);
    parentMemberId = parent.id;

    const { rows: [kid] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji, monthly_budget)
      VALUES ('TestKidAPI', 'kid', '🧒', 150.00)
      ON CONFLICT (name) DO UPDATE SET role = 'kid', monthly_budget = 150.00
      RETURNING id
    `);
    kidMemberId = kid.id;

    const crypto = require('crypto');
    kidSessionToken = crypto.randomUUID();
    parentSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)', [kidSessionToken, kidMemberId, expiresAt]);
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)', [parentSessionToken, parentMemberId, expiresAt]);

    // Create test item and kid account
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-kids-api', 'test-item-kids-api', 'ins_kids_api', 'Kids API Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);

    const { rows: [acct] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
      VALUES ('acct-kid-api', $1, 'Kid API Checking', 'depository', 'checking', '3333', 500, 'TestKidAPI')
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Kid API Checking', current_balance = 500
      RETURNING id
    `, [item.id]);
    kidAccountId = acct.id;

    // Link kid to account
    await pool.query('INSERT INTO account_members (account_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [kidAccountId, kidMemberId]);

    // Seed a transaction
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-kid-api-1', $1, 25.00, CURRENT_DATE, 'Pizza Place', 'Pizza Place', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET merchant_name = 'Pizza Place'
    `, [kidAccountId]);
  });

  after(async () => {
    await pool.query("DELETE FROM sessions WHERE token IN ($1, $2)", [kidSessionToken, parentSessionToken]);
    await pool.query("DELETE FROM account_members WHERE member_id = $1", [kidMemberId]);
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id = 'tx-kid-api-1'");
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-kid-api'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-kids-api'");
    await pool.query("DELETE FROM family_members WHERE name IN ('TestParentAPI', 'TestKidAPI')");
    server.close();
    await pool.end();
  });

  // ── Dashboard ─────────────────────────────────────────────

  it('kid gets dashboard with scoped data', async () => {
    const res = await kidReq('api/kids/dashboard');
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.member.name, 'TestKidAPI');
    assert.equal(data.member.monthly_budget, 150);
    assert.ok(Array.isArray(data.accounts));
    assert.ok(data.accounts.length > 0);
    assert.ok(typeof data.balance_total === 'number');
    assert.ok(typeof data.month_spending === 'number');
    assert.ok(data.budget !== null);
    assert.equal(data.budget.amount, 150);
    assert.ok(Array.isArray(data.recent_transactions));
    assert.ok(Array.isArray(data.category_breakdown));
  });

  it('parent gets 403 from /api/kids/dashboard', async () => {
    const res = await parentReq('api/kids/dashboard');
    assert.equal(res.status, 403);
  });

  // ── Budget setting ────────────────────────────────────────

  it('parent can set kid budget via PUT /api/kids/budget', async () => {
    const res = await parentReq('api/kids/budget', {
      method: 'PUT',
      body: JSON.stringify({ member_id: kidMemberId, amount: 200 })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.monthly_budget, 200);
  });

  it('kid gets 403 from PUT /api/kids/budget', async () => {
    const res = await kidReq('api/kids/budget', {
      method: 'PUT',
      body: JSON.stringify({ member_id: kidMemberId, amount: 999 })
    });
    assert.equal(res.status, 403);
  });

  it('parent cannot set budget for parent-role member', async () => {
    const res = await parentReq('api/kids/budget', {
      method: 'PUT',
      body: JSON.stringify({ member_id: parentMemberId, amount: 100 })
    });
    assert.equal(res.status, 400);
  });
});
