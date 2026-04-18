'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Ensure clean slate for household tests
  await pool.query('DELETE FROM category_rules WHERE created_by = $1', ['setup']);
  await pool.query("DELETE FROM categories WHERE name IN ('Groceries','Dining Out','Income','Uncategorized','Crypto/BTC','529 Contribution')");
  await pool.query('DELETE FROM family_members');
});

after(async () => {
  await pool.query('DELETE FROM category_rules WHERE created_by = $1', ['setup']);
  await pool.query('DELETE FROM categories');
  await pool.query('DELETE FROM family_members');
  server.close();
  await pool.end();
});

describe('GET /api/bootstrap', () => {
  it('reports needs_household when family_members is empty', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.bootstrap.needs_household, true);
    assert.equal(data.status, 'needs_setup');
  });
});

describe('POST /api/bootstrap/household', () => {
  it('rejects missing members array', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap/household`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('rejects members with no parent', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap/household`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: [{ name: 'Riley', role: 'kid' }] }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /parent/i);
  });

  it('creates household with parents and kids', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap/household`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        members: [
          { name: 'Alex',  role: 'parent' },
          { name: 'Jamie', role: 'parent' },
          { name: 'Riley', role: 'kid' },
        ],
        install_starter_content: true,
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.created_members.length, 3);
    assert.ok(data.created_members.every(m => m.avatar_emoji && m.color));
    assert.equal(data.created_members[0].name, 'Alex');
    assert.equal(data.created_members[0].role, 'parent');
    assert.equal(data.created_members[2].role, 'kid');
    assert.equal(data.bootstrap.needs_household, false);
  });

  it('installs default categories when install_starter_content is true', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM categories');
    assert.ok(rows[0].count >= 18, `expected ≥18 categories, got ${rows[0].count}`);
  });

  it('installs auto-categorization rules', async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM category_rules WHERE created_by = 'setup'");
    assert.ok(rows[0].count >= 4, `expected ≥4 rules, got ${rows[0].count}`);
  });

  it('returns 409 if household already configured', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap/household`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: [{ name: 'Another', role: 'parent' }] }),
    });
    assert.equal(res.status, 409);
  });

  it('bootstrap state reports needs_household=false after setup', async () => {
    const res = await fetch(`${baseUrl}/api/bootstrap`);
    const data = await res.json();
    assert.equal(data.bootstrap.needs_household, false);
  });
});
