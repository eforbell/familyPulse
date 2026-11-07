'use strict';

// Express matches routes case-insensitively, so every path spelling that reaches a route has to reach the auth gate
// too. /API/accounts used to skip the gate, because it checked for '/api/' exactly, and reached the route with no
// session at all.
require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { hashPassphrase, createSession } = require('../lib/auth');
const { pool: appPool } = require('../lib/db');
const { app } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('the API gate and path spelling', () => {
  let server;
  let port;
  let parentId;
  let kidId;
  let kidCookie;

  // Host and path separately: a URL string would tidy /x/../ away before it was sent.
  const request = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  before(async () => {
    const insert = "INSERT INTO family_members (name, role, avatar_emoji, color, passphrase_hash) VALUES ($1, $2, 'x', '#111111', $3) RETURNING id";
    ({ rows: [{ id: parentId }] } = await pool.query(insert, ['Gate Parent', 'parent', hashPassphrase('a-test-passphrase')]));
    ({ rows: [{ id: kidId }] } = await pool.query(insert, ['Gate Kid', 'kid', null]));
    kidCookie = { cookie: `fp_session=${(await createSession(kidId)).token}` };
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    ({ port } = server.address());
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM sessions WHERE member_id = $1', [kidId]);
    await pool.query('DELETE FROM family_members WHERE id = ANY($1)', [[parentId, kidId]]);
    await pool.end();
  });

  it('no spelling of a route gets past the session check', async () => {
    for (const path of ['/api/accounts', '/API/accounts', '/Api/accounts', '/aPi/ACCOUNTS', '/api/accounts/', '/API/accounts/',
      '/API/items', '/API/transactions', '/API/categories', '/API/budget', '/API/recurring', '/API/reports/spending-burn']) {
      assert.equal(await request('GET', path), 401, path);
    }
    for (const [method, path] of [['POST', '/API/sync'], ['POST', '/API/link/create-token'], ['DELETE', '/API/items/1'], ['PUT', '/API/auth/account-members']]) {
      assert.equal(await request(method, path), 401, `${method} ${path}`);
    }
  });

  it('no spelling of a parent route lets a kid through', async () => {
    for (const path of ['/api/items', '/API/items', '/API/ITEMS', '/API/status', '/API/anomalies', '/API/magic/digest']) {
      assert.equal(await request('GET', path, kidCookie), 403, path);
    }
    for (const path of ['/API/sync', '/Api/Sync', '/API/link/create-token', '/API/import/upload']) {
      assert.equal(await request('POST', path, kidCookie), 403, path);
    }
    assert.equal(await request('POST', '/API/categories', kidCookie), 403, 'a parent-only write');
  });

  it('the public routes stay public, in any spelling', async () => {
    for (const path of ['/api/health', '/API/health', '/api/auth/members']) assert.equal(await request('GET', path), 200, path);
  });

  it('a page can\'t skip the sign-in redirect by spelling either', async () => {
    assert.equal(await request('GET', '/accounts.html'), 302);
    assert.equal(await request('GET', '/ACCOUNTS.HTML'), 302);
  });

  it('a page is gated by the file it would open, however the path is written', async () => {
    const spellings = ['/%61ccounts.html', '/accounts%2Ehtml', '//accounts.html', '/./accounts.html', '/x/../accounts.html', '/%2faccounts.html', '/%61dmin.html', '//', '/.'];
    for (const path of spellings) assert.equal(await request('GET', path), 302, path);
    for (const path of ['/%61dmin.html', '//admin.html', '/x/../settings.html']) assert.equal(await request('GET', path, kidCookie), 302, `kid ${path}`);
    // Characters a case-insensitive filesystem folds into ASCII open nothing: long s, Kelvin sign.
    for (const path of ['/%C5%BFettings.html', '/account%C5%BF.html']) {
      assert.equal(await request('GET', path), 404, path);
      assert.equal(await request('GET', path, kidCookie), 404, `kid ${path}`);
    }
    assert.equal(await request('GET', '/%E2%84%AAids.html', kidCookie), 404, 'lower case makes this /kids.html, which a kid may open');
    // A path nothing can decode opens no page.
    assert.equal(await request('GET', '/%E0%A4%A.html'), 404);
    // Pages without a gate still open.
    assert.equal(await request('GET', '/login.html'), 200);
  });

  it('HEAD is gated like GET', async () => {
    for (const path of ['/', '/accounts.html', '/admin.html', '/%61dmin.html']) assert.equal(await request('HEAD', path), 302, path);
    assert.equal(await request('HEAD', '/admin.html', kidCookie), 302);
    assert.equal(await request('HEAD', '/login.html'), 200);
  });

  it('when sign-in can\'t be checked, nobody gets in', async () => {
    const realQuery = appPool.query;
    appPool.query = function query(text, ...rest) {
      if (String(text).includes('passphrase_hash IS NOT NULL LIMIT 1')) return Promise.reject(new Error('database unavailable'));
      return realQuery.call(this, text, ...rest);
    };
    try {
      for (const path of ['/api/accounts', '/API/accounts', '/accounts.html', '/admin.html', '/kids/anyone']) {
        assert.equal(await request('GET', path), 503, path);
      }
      assert.equal(await request('DELETE', '/api/items/1'), 503);
    } finally {
      appPool.query = realQuery;
    }
    assert.equal(await request('GET', '/api/accounts'), 401, 'and it recovers when the check works again');
  });
});
