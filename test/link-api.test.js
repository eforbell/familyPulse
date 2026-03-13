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
let testItemId;
const LINK_ITEM_ID = 'test-item-link';
const LINK_ACCOUNT_IDS = ['acct-link-1', 'acct-link-2'];
const DELETE_ITEM_ID = 'test-item-del';
const DELETE_ACCOUNT_ID = 'acct-del-1';
const SESSION_TOKEN = 'test-lt-link-table';
const OAUTH_SESSION_TOKEN = 'test-lt-link-oauth';
const OAUTH_STATE_ID = 'test-oauth-state-link';
const DEFAULT_LINK_TOKEN = 'test-link-token-default';
const LIABILITY_LINK_TOKEN = 'test-link-token-liability';

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
  await pool.query(
    'DELETE FROM link_sessions WHERE link_token = ANY($1::text[])',
    [[SESSION_TOKEN, OAUTH_SESSION_TOKEN, DEFAULT_LINK_TOKEN, LIABILITY_LINK_TOKEN]]
  );
  await pool.query('DELETE FROM accounts WHERE plaid_account_id = ANY($1::text[])', [LINK_ACCOUNT_IDS]);
  await pool.query('DELETE FROM items WHERE item_id = $1', [LINK_ITEM_ID]);
  await pool.query('DELETE FROM items WHERE item_id = $1', [DELETE_ITEM_ID]);
  server.close();
  await pool.end();
});

// ── GET /api/items ──────────────────────────────────────────

describe('GET /api/items', () => {
  it('returns items with account counts', async () => {
    const res = await fetch(`${baseUrl}/api/items`);
    assert.equal(res.status, 200);
    const items = await res.json();
    assert.ok(Array.isArray(items));
    const testItem = items.find(i => i.item_id === LINK_ITEM_ID);
    assert.ok(testItem);
    assert.equal(testItem.institution_name, 'Test Bank Link');
    assert.equal(testItem.account_count, 2);
    assert.equal(testItem.status, 'good');
  });
});

describe('Plaid link token routes', () => {
  const originalCreateLinkToken = require('../lib/plaid-client').createLinkToken;

  after(() => {
    require('../lib/plaid-client').createLinkToken = originalCreateLinkToken;
  });

  it('default link flow requests transactions only', async () => {
    let requestedProducts = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedProducts = opts.products;
      return {
        link_token: DEFAULT_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    const res = await fetch(`${baseUrl}/api/link/create-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    assert.deepEqual(requestedProducts, ['transactions']);
  });

  it('liability link flow requests transactions and liabilities', async () => {
    let requestedProducts = null;
    require('../lib/plaid-client').createLinkToken = async (opts = {}) => {
      requestedProducts = opts.products;
      return {
        link_token: LIABILITY_LINK_TOKEN,
        expiration: '2099-01-01T00:00:00Z'
      };
    };

    const res = await fetch(`${baseUrl}/api/link/create-liability-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    assert.deepEqual(requestedProducts, ['transactions', 'liabilities']);
  });
});

// ── PUT /api/items/:id/owner ────────────────────────────────

describe('PUT /api/items/:id/owner', () => {
  it('assigns owner to all accounts of an item', async () => {
    const res = await fetch(`${baseUrl}/api/items/${testItemId}/owner`, {
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

  it('returns 404 for non-existent item', async () => {
    const res = await fetch(`${baseUrl}/api/items/999999/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'Alex' })
    });
    assert.equal(res.status, 404);
  });
});

// ── DELETE /api/items/:id ───────────────────────────────────

describe('DELETE /api/items/:id', () => {
  it('removes an item and cascaded accounts', async () => {
    // Create a throwaway item to delete
    const { rows: [delItem] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-del', $1, 'ins_del', 'Delete Me Bank', 'good')
      RETURNING id
    `, [DELETE_ITEM_ID]);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ($2, $1, 'Del Account', 'depository', 'checking', '0000', 0)
    `, [delItem.id, DELETE_ACCOUNT_ID]);

    const res = await fetch(`${baseUrl}/api/items/${delItem.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Verify cascade
    const { rows: accts } = await pool.query(
      'SELECT id FROM accounts WHERE plaid_account_id = $1',
      [DELETE_ACCOUNT_ID]
    );
    assert.equal(accts.length, 0);
  });

  it('returns 404 for non-existent item', async () => {
    const res = await fetch(`${baseUrl}/api/items/999999`, {
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
      [[SESSION_TOKEN, OAUTH_SESSION_TOKEN, DEFAULT_LINK_TOKEN, LIABILITY_LINK_TOKEN]]
    );
    await insertPendingLinkSession(OAUTH_SESSION_TOKEN, 'Eric');

    const res = await fetch(`${baseUrl}/oauth/callback?oauth_state_id=${OAUTH_STATE_ID}`);
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
    const res = await fetch(`${baseUrl}/settings.html`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Linked Institutions'));
  });

  it('serves settings.js', async () => {
    const res = await fetch(`${baseUrl}/settings.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('startLink'));
  });
});
