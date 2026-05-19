'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');

let server;
let baseUrl;
let parentMemberId;
let kidMemberId;
let parentSessionToken;
let kidSessionToken;
let itemId;
let parentAccountId;
let investmentAccountId;
let parentCreditAccountId;
let kidAccountId;

const PARENT_NAME = 'BalancePolicyParent';
const KID_NAME = 'BalancePolicyKid';
const ITEM_KEY = 'test-item-balance-policy-api';

function req(path, opts = {}) {
  return fetch(`${baseUrl}/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers
    }
  });
}

function parentReq(path, opts = {}) {
  return req(path, {
    ...opts,
    headers: {
      Cookie: `fp_session=${parentSessionToken}`,
      ...opts.headers
    }
  });
}

function kidReq(path, opts = {}) {
  return req(path, {
    ...opts,
    headers: {
      Cookie: `fp_session=${kidSessionToken}`,
      ...opts.headers
    }
  });
}

describe('balance policy API', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const { rows: [parent] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji)
      VALUES ($1, 'parent', '🧑')
      ON CONFLICT (name) DO UPDATE SET role = 'parent'
      RETURNING id
    `, [PARENT_NAME]);
    parentMemberId = parent.id;

    const { rows: [kid] } = await pool.query(`
      INSERT INTO family_members (name, role, avatar_emoji)
      VALUES ($1, 'kid', '🧒')
      ON CONFLICT (name) DO UPDATE SET role = 'kid'
      RETURNING id
    `, [KID_NAME]);
    kidMemberId = kid.id;

    parentSessionToken = crypto.randomUUID();
    kidSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3), ($4, $5, $3)',
      [parentSessionToken, parentMemberId, expiresAt, kidSessionToken, kidMemberId]
    );

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-balance-policy-api', $1, 'ins_balance_api', 'Balance Policy Test Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `, [ITEM_KEY]);
    itemId = item.id;

    const { rows: [parentAccount] } = await pool.query(`
      INSERT INTO accounts (
        plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner
      )
      VALUES ('acct-balance-parent-checking', $1, 'Parent Checking', 'depository', 'checking', '1111', 1000.00, 850.00, $2)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 1000.00,
        available_balance = 850.00,
        owner = $2
      RETURNING id
    `, [itemId, PARENT_NAME]);
    parentAccountId = parentAccount.id;

    const { rows: [investmentAccount] } = await pool.query(`
      INSERT INTO accounts (
        plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner
      )
      VALUES ('acct-balance-parent-mm', $1, 'Parent Money Market', 'investment', 'money market', '2222', 2000.00, 1800.00, $2)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 2000.00,
        available_balance = 1800.00,
        owner = $2
      RETURNING id
    `, [itemId, PARENT_NAME]);
    investmentAccountId = investmentAccount.id;

    const { rows: [kidAccount] } = await pool.query(`
      INSERT INTO accounts (
        plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner
      )
      VALUES ('acct-balance-kid-checking', $1, 'Kid Checking', 'depository', 'checking', '3333', 500.00, 450.00, $2)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 500.00,
        available_balance = 450.00,
        owner = $2
      RETURNING id
    `, [itemId, KID_NAME]);
    kidAccountId = kidAccount.id;

    await pool.query(`
      INSERT INTO account_members (account_id, member_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [kidAccountId, kidMemberId]);

    const { rows: [parentCreditAccount] } = await pool.query(`
      INSERT INTO accounts (
        plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance, owner
      )
      VALUES ('acct-balance-parent-credit', $1, 'Parent Credit Card', 'credit', 'credit card', '4444', 600.00, NULL, $2)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        current_balance = 600.00,
        available_balance = NULL,
        owner = $2
      RETURNING id
    `, [itemId, PARENT_NAME]);
    parentCreditAccountId = parentCreditAccount.id;

    await pool.query(`
      INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
      ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
    `);
  });

  after(async () => {
    await pool.query('DELETE FROM sessions WHERE token IN ($1, $2)', [parentSessionToken, kidSessionToken]);
    await pool.query('DELETE FROM account_members WHERE account_id = $1', [kidAccountId]);
    await pool.query(`
      DELETE FROM accounts
      WHERE plaid_account_id IN ('acct-balance-parent-checking', 'acct-balance-parent-mm', 'acct-balance-kid-checking', 'acct-balance-parent-credit')
    `);
    await pool.query('DELETE FROM items WHERE item_id = $1', [ITEM_KEY]);
    await pool.query('DELETE FROM family_members WHERE name IN ($1, $2)', [PARENT_NAME, KID_NAME]);
    await pool.query(`
      INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
      ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
    `);

    server.close();
    await pool.end();
  });

  it('returns and updates the household balance basis for parents', async () => {
    let res = await parentReq('api/settings/balance-basis');
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.balance_basis, 'available_preferred');
    assert.equal(data.depository_balance_label, 'Available');

    res = await parentReq('api/settings/balance-basis', {
      method: 'PUT',
      body: JSON.stringify({ balance_basis: 'current_only' })
    });
    assert.equal(res.status, 200);

    res = await parentReq('api/settings/balance-basis');
    data = await res.json();
    assert.equal(data.balance_basis, 'current_only');
    assert.equal(data.depository_balance_label, 'Ledger');
  });

  it('rejects invalid balance basis values', async () => {
    const res = await parentReq('api/settings/balance-basis', {
      method: 'PUT',
      body: JSON.stringify({ balance_basis: 'bad_value' })
    });

    assert.equal(res.status, 400);
  });

  it('uses available balances for depository accounts in dashboard cash totals by default', async () => {
    await pool.query(`
      INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
      ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
    `);

    const res = await parentReq('api/accounts/dashboard');
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.balance_basis, 'available_preferred');
    assert.equal(data.depository_balance_label, 'Available');

    const parentGroup = data.groups[PARENT_NAME];
    assert.ok(parentGroup);
    assert.equal(
      parentGroup.reduce((sum, account) => sum + account.display_balance, 0),
      3450
    );
    const checking = parentGroup.find(account => account.id === parentAccountId);
    assert.equal(checking.display_balance, 850);
    assert.equal(checking.display_balance_kind, 'available');

    const moneyMarket = parentGroup.find(account => account.subtype === 'money market');
    assert.equal(moneyMarket.display_balance, 2000);
    assert.equal(moneyMarket.display_balance_kind, 'ledger');

    const kidGroup = data.groups[KID_NAME];
    assert.ok(kidGroup);
    assert.equal(kidGroup[0].display_balance, 450);
  });

  it('orders owner groups by cash balances first, then liabilities by balance descending', async () => {
    const res = await parentReq('api/accounts/dashboard');
    assert.equal(res.status, 200);
    const data = await res.json();

    const parentGroup = data.groups[PARENT_NAME];
    assert.ok(parentGroup);
    assert.deepEqual(
      parentGroup.map((account) => account.id),
      [investmentAccountId, parentAccountId, parentCreditAccountId]
    );
  });

  it('excludes historical accounts from live dashboard totals while retaining them separately', async () => {
    const baselineParentRes = await parentReq('api/accounts/dashboard');
    assert.equal(baselineParentRes.status, 200);
    const baselineParentData = await baselineParentRes.json();

    await pool.query(`
      UPDATE accounts
      SET sync_status = 'historical', sync_disabled_at = now()
      WHERE plaid_account_id IN ('acct-balance-parent-checking', 'acct-balance-kid-checking')
    `);

    try {
      const parentRes = await parentReq('api/accounts/dashboard');
      assert.equal(parentRes.status, 200);
      const parentData = await parentRes.json();

      assert.equal(parentData.account_count, baselineParentData.account_count - 2);
      assert.equal(parentData.historical_account_count, baselineParentData.historical_account_count + 2);
      assert.equal(parentData.liquid_total, baselineParentData.liquid_total - 1300);
      assert.equal(parentData.groups[PARENT_NAME].length, 2);
      assert.equal(parentData.groups[KID_NAME], undefined);
      assert.equal(parentData.historical_groups[PARENT_NAME][0].id, parentAccountId);
      assert.equal(parentData.historical_groups[KID_NAME][0].id, kidAccountId);

      const kidRes = await kidReq('api/kids/dashboard');
      assert.equal(kidRes.status, 200);
      const kidData = await kidRes.json();
      assert.equal(kidData.balance_total, 0);
      assert.equal(kidData.account_count, 0);
      assert.equal(kidData.historical_account_count, 1);
      assert.equal(kidData.accounts.length, 0);
      assert.equal(kidData.historical_accounts.length, 1);
      assert.equal(kidData.historical_accounts[0].id, kidAccountId);
    } finally {
      await pool.query(`
        UPDATE accounts
        SET sync_status = 'active', sync_disabled_at = NULL
        WHERE plaid_account_id IN ('acct-balance-parent-checking', 'acct-balance-kid-checking')
      `);
    }
  });

  it('uses configured basis for kid dashboard totals', async () => {
    await pool.query(`
      INSERT INTO app_config (key, value) VALUES ('balance_basis', 'current_only')
      ON CONFLICT (key) DO UPDATE SET value = 'current_only'
    `);

    let res = await kidReq('api/kids/dashboard');
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.equal(data.balance_total, 500);
    assert.equal(data.depository_balance_label, 'Ledger');

    await pool.query(`
      INSERT INTO app_config (key, value) VALUES ('balance_basis', 'available_preferred')
      ON CONFLICT (key) DO UPDATE SET value = 'available_preferred'
    `);

    res = await kidReq('api/kids/dashboard');
    assert.equal(res.status, 200);
    data = await res.json();
    assert.equal(data.balance_total, 450);
    assert.equal(data.depository_balance_label, 'Available');
    assert.equal(data.accounts[0].display_balance, 450);
    assert.equal(data.accounts[0].ledger_balance, 500);
  });
});
