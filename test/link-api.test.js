'use strict';

require('dotenv').config();
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Start a real server for HTTP testing
const { app } = require('../server');
let server;
let baseUrl;
let testItemId;
const LINK_ITEM_ID = 'test-item-link';
const LINK_ACCOUNT_IDS = ['acct-link-1', 'acct-link-2'];
const DELETE_ITEM_ID = 'test-item-del';
const DELETE_ACCOUNT_ID = 'acct-del-1';
const TIMEOUT_ITEM_ID = 'test-item-timeout';
const TIMEOUT_ACCOUNT_ID = 'acct-timeout-1';
const SESSION_TOKEN = 'test-lt-link-table';
const OAUTH_SESSION_TOKEN = 'test-lt-link-oauth';
const OAUTH_STATE_ID = 'test-oauth-state-link';
const DEFAULT_LINK_TOKEN = 'test-link-token-default';
const UPGRADE_LINK_TOKEN = 'test-link-token-upgrade';
const ACCOUNT_SELECTION_LINK_TOKEN = 'test-link-token-account-selection';
let parentSessionToken;

function authFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      Cookie: `fp_session=${parentSessionToken}`,
      ...opts.headers
    }
  });
}

async function insertPendingLinkSession(linkToken, owner) {
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
  await pool.query(`
    INSERT INTO link_sessions (link_token, status, owner, expires_at)
    VALUES ($1, 'pending', $2, $3)
  `, [linkToken, owner, expiresAt]);
}

before(async () => {
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const { rows: [parent] } = await pool.query(
    "SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1"
  );
  parentSessionToken = crypto.randomUUID();
  await pool.query(
    'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, now() + interval \'1 day\')',
    [parentSessionToken, parent.id]
  );

  // Seed a test item
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-link', $1, 'ins_link', 'Test Bank Link', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `, [LINK_ITEM_ID]);
  testItemId = item.id;

  // Seed accounts for that item
  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
    VALUES ($2, $1, 'Link Checking', 'depository', 'checking', '1111', 1000, 'Eric'),
           ($3, $1, 'Link Savings', 'depository', 'savings', '2222', 5000, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name
  `, [testItemId, LINK_ACCOUNT_IDS[0], LINK_ACCOUNT_IDS[1]]);
});

after(async () => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [parentSessionToken]);
  await pool.query(`
    DELETE FROM account_members
    WHERE account_id IN (
      SELECT id FROM accounts WHERE plaid_account_id = ANY($1::text[])
    )
  `, [LINK_ACCOUNT_IDS]);
  await pool.query(
    'DELETE FROM link_sessions WHERE link_token = ANY($1::text[])',
    [[SESSION_TOKEN, OAUTH_SESSION_TOKEN, DEFAULT_LINK_TOKEN, UPGRADE_LINK_TOKEN, ACCOUNT_SELECTION_LINK_TOKEN]]
  );
  await pool.query('DELETE FROM accounts WHERE plaid_account_id = ANY($1::text[])', [LINK_ACCOUNT_IDS]);
  await pool.query('DELETE FROM items WHERE item_id = $1', [LINK_ITEM_ID]);
  await pool.query('DELETE FROM items WHERE item_id = ANY($1::text[])', [[DELETE_ITEM_ID, TIMEOUT_ITEM_ID]]);
  server.close();
  await pool.end();
});

// ── GET /api/items ──────────────────────────────────────────

describe('GET /api/items', () => {
  it('returns items with account counts', async () => {
    const res = await authFetch(`${baseUrl}/api/items`);
    assert.equal(res.status, 200);
    const items = await res.json();
    assert.ok(Array.isArray(items));
    const testItem = items.find(i => i.item_id === LINK_ITEM_ID);
    assert.ok(testItem);
    assert.equal(testItem.institution_name, 'Test Bank Link');
    assert.equal(testItem.account_count, 2);
    assert.equal(testItem.status, 'good');
  });

  it('returns item account detail with active and historical sync status', async () => {
    await pool.query(
      "UPDATE accounts SET sync_status = 'historical', sync_disabled_at = now() WHERE plaid_account_id = $1",
      [LINK_ACCOUNT_IDS[1]]
    );

    const res = await authFetch(`${baseUrl}/api/items/${testItemId}/accounts`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.item.id, testItemId);
    assert.equal(data.accounts.length, 2);
    assert.deepEqual(
      data.accounts.map((account) => ({ plaid_account_id: account.plaid_account_id, sync_status: account.sync_status })),
      [
        { plaid_account_id: LINK_ACCOUNT_IDS[0], sync_status: 'active' },
        { plaid_account_id: LINK_ACCOUNT_IDS[1], sync_status: 'historical' }
      ]
    );

    await pool.query(
      "UPDATE accounts SET sync_status = 'active', sync_disabled_at = NULL WHERE plaid_account_id = $1",
      [LINK_ACCOUNT_IDS[1]]
    );
  });
});

describe('Plaid link token routes', () => {
  const originalCreateLinkToken = require('../lib/plaid-client').createLinkToken;
  const originalGetItemInfo = require('../lib/plaid-client').getItemInfo;
  const originalGetAccounts = require('../lib/plaid-client').getAccounts;

  after(() => {
    require('../lib/plaid-client').createLinkToken = originalCreateLinkToken;
    require('../lib/plaid-client').getItemInfo = originalGetItemInfo;
    require('../lib/plaid-client').getAccounts = originalGetAccounts;
  });

  it('default link flow requests transactions plus additional liability consent', async () => {
    let requestedProducts = null;
    let requestedAdditionalConsentedProducts = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedProducts = opts.products;
      requestedAdditionalConsentedProducts = opts.additionalConsentedProducts;
      return {
        link_token: DEFAULT_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    const res = await authFetch(`${baseUrl}/api/link/create-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    assert.deepEqual(requestedProducts, ['transactions']);
    assert.deepEqual(requestedAdditionalConsentedProducts, ['liabilities']);
  });

  it('liability upgrade flow uses update mode with additional liability consent', async () => {
    let requestedAccessToken = null;
    let requestedAdditionalConsentedProducts = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedAccessToken = opts.accessToken;
      requestedAdditionalConsentedProducts = opts.additionalConsentedProducts;
      return {
        link_token: UPGRADE_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    const res = await authFetch(`${baseUrl}/api/link/create-liability-upgrade-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: testItemId })
    });
    assert.equal(res.status, 200);
    assert.equal(requestedAccessToken, 'test-token-link');
    assert.deepEqual(requestedAdditionalConsentedProducts, ['liabilities']);
  });

  it('account selection flow uses update mode with account selection enabled', async () => {
    let requestedAccessToken = null;
    let requestedUpdate = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedAccessToken = opts.accessToken;
      requestedUpdate = opts.update;
      return {
        link_token: ACCOUNT_SELECTION_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    const res = await authFetch(`${baseUrl}/api/link/create-account-selection-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: testItemId })
    });
    assert.equal(res.status, 200);
    assert.equal(requestedAccessToken, 'test-token-link');
    assert.deepEqual(requestedUpdate, { account_selection_enabled: true });
  });

  it('allows Chase items to open account selection while keeping bank-managed removal guidance', async () => {
    await pool.query(
      `UPDATE items
       SET institution_id = 'ins_56', institution_name = 'Chase'
       WHERE id = $1`,
      [testItemId]
    );

    let requestedAccessToken = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedAccessToken = opts.accessToken;
      return {
        link_token: ACCOUNT_SELECTION_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    try {
      const itemRes = await authFetch(`${baseUrl}/api/items`);
      assert.equal(itemRes.status, 200);
      const items = await itemRes.json();
      const chaseItem = items.find((item) => item.id === testItemId);
      assert.equal(chaseItem.account_selection.mode, 'editable');
      assert.equal(chaseItem.account_selection.removal_requires_bank, true);

      const res = await authFetch(`${baseUrl}/api/link/create-account-selection-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: testItemId })
      });
      assert.equal(res.status, 200);
      assert.equal(requestedAccessToken, 'test-token-link');
    } finally {
      await pool.query(
        `UPDATE items
         SET institution_id = 'ins_test', institution_name = 'Test Bank'
         WHERE id = $1`,
        [testItemId]
      );
    }
  });

  it('completes liability upgrade without a public token by refreshing item state', async () => {
    require('../lib/plaid-client').getItemInfo = async () => ({
      item: {
        institution_id: 'ins_link',
        products: ['transactions'],
        consented_products: ['transactions', 'liabilities'],
        available_products: ['liabilities']
      }
    });
    require('../lib/plaid-client').getAccounts = async () => ({
      accounts: [{
        account_id: LINK_ACCOUNT_IDS[0],
        name: 'Link Checking',
        official_name: 'Link Checking',
        type: 'credit',
        subtype: 'credit card',
        mask: '1111',
        balances: { current: 1000, available: null, iso_currency_code: 'USD' }
      }]
    });

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const { rows: [session] } = await pool.query(`
      INSERT INTO link_sessions (link_token, status, owner, item_id_for_update, expires_at)
      VALUES ($1, 'pending', $2, $3, $4)
      RETURNING id
    `, [UPGRADE_LINK_TOKEN, 'Eric', testItemId, expiresAt]);

    await pool.query(
      "UPDATE items SET liability_access_status = 'missing' WHERE id = $1",
      [testItemId]
    );

    const res = await authFetch(`${baseUrl}/api/link/complete-liability-upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_session_id: session.id })
    });
    assert.equal(res.status, 200);

    const { rows: [item] } = await pool.query(
      'SELECT liability_access_status FROM items WHERE id = $1',
      [testItemId]
    );
    assert.equal(item.liability_access_status, 'enabled');

    const { rows: [updatedSession] } = await pool.query(
      'SELECT status FROM link_sessions WHERE id = $1',
      [session.id]
    );
    assert.equal(updatedSession.status, 'exchanged');
  });

  it('completes account selection without a public token and marks absent accounts historical', async () => {
    require('../lib/plaid-client').getAccounts = async () => ({
      accounts: [{
        account_id: LINK_ACCOUNT_IDS[0],
        name: 'Link Checking',
        official_name: 'Link Checking',
        type: 'depository',
        subtype: 'checking',
        mask: '1111',
        balances: { current: 1000, available: 900, iso_currency_code: 'USD' }
      }]
    });

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const { rows: [session] } = await pool.query(`
      INSERT INTO link_sessions (link_token, status, owner, item_id_for_update, expires_at)
      VALUES ($1, 'pending', $2, $3, $4)
      RETURNING id
    `, [ACCOUNT_SELECTION_LINK_TOKEN, 'Eric', testItemId, expiresAt]);

    const res = await authFetch(`${baseUrl}/api/link/complete-account-selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link_session_id: session.id })
    });
    assert.equal(res.status, 200);

    const { rows } = await pool.query(`
      SELECT plaid_account_id, sync_status
      FROM accounts
      WHERE item_id = $1
      ORDER BY plaid_account_id
    `, [testItemId]);
    assert.deepEqual(rows, [
      { plaid_account_id: LINK_ACCOUNT_IDS[0], sync_status: 'active' },
      { plaid_account_id: LINK_ACCOUNT_IDS[1], sync_status: 'historical' }
    ]);
  });
});

// ── PUT /api/items/:id/owner ────────────────────────────────

describe('PUT /api/items/:id/owner', () => {
  it('assigns owner to all accounts of an item', async () => {
    const res = await authFetch(`${baseUrl}/api/items/${testItemId}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Alex' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.updated, 2);

    // Verify in DB
    const { rows } = await pool.query(
      'SELECT owner FROM accounts WHERE item_id = $1', [testItemId]
    );
    assert.ok(rows.every(r => r.owner === 'Alex'));

    // Restore original owner
    await pool.query(
      'UPDATE accounts SET owner = $1 WHERE item_id = $2', ['Eric', testItemId]
    );
  });

  it('reconciles account_members when kid ownership changes', async () => {
    const { rows: [jordan] } = await pool.query(
      "SELECT id FROM family_members WHERE name = 'Jordan'"
    );
    const { rows: [casey] } = await pool.query(
      "SELECT id FROM family_members WHERE name = 'Casey'"
    );
    assert.ok(jordan);
    assert.ok(casey);

    let res = await authFetch(`${baseUrl}/api/items/${testItemId}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Jordan' })
    });
    assert.equal(res.status, 200);

    let { rows } = await pool.query(`
      SELECT member_id, count(*)::int AS linked
      FROM account_members am
      JOIN accounts a ON a.id = am.account_id
      WHERE a.item_id = $1
      GROUP BY member_id
      ORDER BY member_id
    `, [testItemId]);
    assert.deepEqual(rows, [{ member_id: jordan.id, linked: 2 }]);

    res = await authFetch(`${baseUrl}/api/items/${testItemId}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Casey' })
    });
    assert.equal(res.status, 200);

    ({ rows } = await pool.query(`
      SELECT member_id, count(*)::int AS linked
      FROM account_members am
      JOIN accounts a ON a.id = am.account_id
      WHERE a.item_id = $1
      GROUP BY member_id
      ORDER BY member_id
    `, [testItemId]));
    assert.deepEqual(rows, [{ member_id: casey.id, linked: 2 }]);

    res = await authFetch(`${baseUrl}/api/items/${testItemId}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Alex' })
    });
    assert.equal(res.status, 200);

    const { rows: cleared } = await pool.query(`
      SELECT am.member_id
      FROM account_members am
      JOIN accounts a ON a.id = am.account_id
      WHERE a.item_id = $1
    `, [testItemId]);
    assert.equal(cleared.length, 0);

    await pool.query(
      'UPDATE accounts SET owner = $1 WHERE item_id = $2',
      ['Eric', testItemId]
    );
  });

  it('returns 404 for non-existent item', async () => {
    const res = await authFetch(`${baseUrl}/api/items/999999/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Alex' })
    });
    assert.equal(res.status, 404);
  });
});

// ── DELETE /api/items/:id ───────────────────────────────────

describe('DELETE /api/items/:id', () => {
  const originalRemoveItem = require('../lib/plaid-client').removeItem;

  afterEach(() => {
    require('../lib/plaid-client').removeItem = originalRemoveItem;
  });

  it('disconnects an item remotely and preserves local history', async () => {
    require('../lib/plaid-client').removeItem = async () => ({ removed: true });

    const { rows: [delItem] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-del', $1, 'ins_del', 'Delete Me Bank', 'good')
      RETURNING id
    `, [DELETE_ITEM_ID]);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ($2, $1, 'Del Account', 'depository', 'checking', '0000', 0)
      ON CONFLICT (plaid_account_id) DO UPDATE SET item_id = EXCLUDED.item_id
    `, [delItem.id, DELETE_ACCOUNT_ID]);

    const res = await authFetch(`${baseUrl}/api/items/${delItem.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.disconnected, true);
    assert.equal(data.preserved_history, true);

    const { rows: [itemRow] } = await pool.query(
      'SELECT status, disconnected_at, access_token FROM items WHERE id = $1',
      [delItem.id]
    );
    assert.equal(itemRow.status, 'disconnected');
    assert.ok(itemRow.disconnected_at);
    assert.equal(itemRow.access_token, `[DISCONNECTED]:${DELETE_ITEM_ID}`);

    const { rows: accts } = await pool.query(
      'SELECT id, sync_status, sync_disabled_at FROM accounts WHERE plaid_account_id = $1',
      [DELETE_ACCOUNT_ID]
    );
    assert.equal(accts.length, 1);
    assert.equal(accts[0].sync_status, 'historical');
    assert.ok(accts[0].sync_disabled_at);
  });

  it('returns a prompt retry-safe response when Plaid removal times out', async () => {
    require('../lib/plaid-client').removeItem = async () => {
      const err = new Error('Plaid request timed out');
      err.code = 'PLAID_REQUEST_TIMEOUT';
      throw err;
    };

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-timeout', $1, 'ins_timeout', 'Timeout Bank', 'good')
      RETURNING id
    `, [TIMEOUT_ITEM_ID]);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ($2, $1, 'Timeout Account', 'depository', 'checking', '9999', 0)
    `, [item.id, TIMEOUT_ACCOUNT_ID]);

    const res = await authFetch(`${baseUrl}/api/items/${item.id}`, { method: 'DELETE' });
    assert.equal(res.status, 504);
    const data = await res.json();
    assert.match(data.error, /refresh Settings before retrying/i);

    const { rows: [itemRow] } = await pool.query(
      'SELECT status, disconnected_at FROM items WHERE id = $1',
      [item.id]
    );
    assert.equal(itemRow.status, 'good');
    assert.equal(itemRow.disconnected_at, null);

    const { rows: [accountRow] } = await pool.query(
      'SELECT sync_status FROM accounts WHERE plaid_account_id = $1',
      [TIMEOUT_ACCOUNT_ID]
    );
    assert.equal(accountRow.sync_status, 'active');
  });

  it('purges local history only after an item is disconnected', async () => {
    require('../lib/plaid-client').removeItem = async () => ({ removed: true });

    const { rows: [delItem] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-del', $1, 'ins_del', 'Delete Me Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        status = 'good',
        disconnected_at = NULL
      RETURNING id
    `, [DELETE_ITEM_ID]);

    let res = await authFetch(`${baseUrl}/api/items/${delItem.id}/purge`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 409);

    res = await authFetch(`${baseUrl}/api/items/${delItem.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);

    res = await authFetch(`${baseUrl}/api/items/${delItem.id}/purge`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.purged, true);

    const { rows: items } = await pool.query(
      'SELECT id FROM items WHERE id = $1',
      [delItem.id]
    );
    assert.equal(items.length, 0);
  });

  it('falls back to local disconnect when Plaid reports the item is already gone', async () => {
    require('../lib/plaid-client').removeItem = async () => {
      const err = new Error('Item not found');
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    };

    const { rows: [delItem] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-del', $1, 'ins_del', 'Delete Me Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        status = 'good',
        disconnected_at = NULL
      RETURNING id
    `, [DELETE_ITEM_ID]);

    const res = await authFetch(`${baseUrl}/api/items/${delItem.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.disconnected, true);

    const { rows: [itemRow] } = await pool.query(
      'SELECT status, disconnected_at FROM items WHERE id = $1',
      [delItem.id]
    );
    assert.equal(itemRow.status, 'disconnected');
    assert.ok(itemRow.disconnected_at);
  });

  it('returns 404 for non-existent item', async () => {
    const res = await authFetch(`${baseUrl}/api/items/999999`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 404);
  });
});

// ── Link session table ──────────────────────────────────────

describe('link_sessions table', () => {
  it('can store and query link sessions', async () => {
    await insertPendingLinkSession(SESSION_TOKEN, 'Eric');

    const { rows } = await pool.query(
      'SELECT * FROM link_sessions WHERE link_token = $1',
      [SESSION_TOKEN]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].owner, 'Eric');

    await pool.query('DELETE FROM link_sessions WHERE link_token = $1', [SESSION_TOKEN]);
  });
});

// ── OAuth callback route ────────────────────────────────────

describe('GET /oauth/callback', () => {
  it('requires oauth_state_id', async () => {
    const res = await fetch(`${baseUrl}/oauth/callback`);
    assert.equal(res.status, 400);
  });

  it('binds the oauth_state_id to the pending session and serves the resume page', async () => {
    await pool.query(
      'DELETE FROM link_sessions WHERE link_token = ANY($1::text[])',
      [[SESSION_TOKEN, OAUTH_SESSION_TOKEN, DEFAULT_LINK_TOKEN, UPGRADE_LINK_TOKEN, ACCOUNT_SELECTION_LINK_TOKEN]]
    );
    await insertPendingLinkSession(OAUTH_SESSION_TOKEN, 'Eric');

    const res = await authFetch(`${baseUrl}/oauth/callback?oauth_state_id=${OAUTH_STATE_ID}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Completing bank connection'));
    assert.ok(text.includes('receivedRedirectUri'));
    assert.ok(text.includes(OAUTH_SESSION_TOKEN));

    const { rows } = await pool.query(
      'SELECT oauth_state_id FROM link_sessions WHERE link_token = $1',
      [OAUTH_SESSION_TOKEN]
    );
    assert.equal(rows[0].oauth_state_id, OAUTH_STATE_ID);
  });
});

// ── Static pages ────────────────────────────────────────────

describe('static pages', () => {
  it('serves settings.html', async () => {
    const res = await authFetch(`${baseUrl}/settings.html`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Linked Institutions'));
  });

  it('serves settings.js', async () => {
    const res = await authFetch(`${baseUrl}/settings.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('startLink'));
  });
});
