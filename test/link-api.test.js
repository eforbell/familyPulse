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

before(async () => {
  server = app.listen(0);
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Seed a test item
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-link', 'test-item-link', 'ins_link', 'Test Bank Link', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  testItemId = item.id;

  // Seed accounts for that item
  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, owner)
    VALUES ('acct-link-1', $1, 'Link Checking', 'depository', 'checking', '1111', 1000, 'Eric'),
           ('acct-link-2', $1, 'Link Savings', 'depository', 'savings', '2222', 5000, 'Eric')
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name
  `, [testItemId]);
});

after(async () => {
  await pool.query("DELETE FROM link_sessions WHERE link_token LIKE 'test-%'");
  await pool.query("DELETE FROM accounts WHERE plaid_account_id LIKE 'acct-link-%'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-link'");
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
    const testItem = items.find(i => i.item_id === 'test-item-link');
    assert.ok(testItem);
    assert.equal(testItem.institution_name, 'Test Bank Link');
    assert.equal(testItem.account_count, 2);
    assert.equal(testItem.status, 'good');
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
      VALUES ('test-token-del', 'test-item-del', 'ins_del', 'Delete Me Bank', 'good')
      RETURNING id
    `);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-del-1', $1, 'Del Account', 'depository', 'checking', '0000', 0)
    `, [delItem.id]);

    const res = await fetch(`${baseUrl}/api/items/${delItem.id}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    // Verify cascade
    const { rows: accts } = await pool.query(
      "SELECT id FROM accounts WHERE plaid_account_id = 'acct-del-1'"
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
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    await pool.query(`
      INSERT INTO link_sessions (link_token, status, owner, expires_at)
      VALUES ('test-lt-1', 'pending', 'Eric', $1)
    `, [expiresAt]);

    const { rows } = await pool.query(
      "SELECT * FROM link_sessions WHERE link_token = 'test-lt-1'"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].owner, 'Eric');

    // Keep this test isolated from oauth callback tests that rely on a single pending session.
    await pool.query("DELETE FROM link_sessions WHERE link_token = 'test-lt-1'");
  });
});

// ── OAuth callback route ────────────────────────────────────

describe('GET /oauth/callback', () => {
  it('requires oauth_state_id', async () => {
    const res = await fetch(`${baseUrl}/oauth/callback`);
    assert.equal(res.status, 400);
  });

  it('binds the oauth_state_id to the pending session and serves the resume page', async () => {
    // Ensure deterministic setup for findOrBindOauthSession (expects exactly one pending null-oauth session).
    await pool.query("DELETE FROM link_sessions WHERE link_token LIKE 'test-lt-%'");

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    await pool.query(`
      INSERT INTO link_sessions (link_token, status, owner, expires_at)
      VALUES ('test-lt-oauth', 'pending', 'Eric', $1)
    `, [expiresAt]);

    const res = await fetch(`${baseUrl}/oauth/callback?oauth_state_id=test-oauth-state`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Completing bank connection'));
    assert.ok(text.includes('receivedRedirectUri'));
    assert.ok(text.includes('test-lt-oauth'));

    const { rows } = await pool.query(
      "SELECT oauth_state_id FROM link_sessions WHERE link_token = 'test-lt-oauth'"
    );
    assert.equal(rows[0].oauth_state_id, 'test-oauth-state');
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
