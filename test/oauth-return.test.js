'use strict';

// The bank sign-in return. Plaid redirects the browser to PLAID_OAUTH_REDIRECT_URI, which can be a public address, so
// that route answers anyone. It used to bind the pending link session to whatever oauth_state_id it was sent and put
// the household's link token in the page, and a POST to it exchanged a public_token, all with no session. Now the
// public route only redirects to Pulse's own address, and resuming happens behind a parent's sign-in.
require('dotenv').config();
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { hashPassphrase, createSession } = require('../lib/auth');
const { app } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TOKEN = 'test-lt-oauth-return';
const OTHER_TOKEN = 'test-lt-oauth-return-other';
const APP_URL = 'https://pulse.example.com/pulse';
const REDIRECT = 'https://public-callback.example.com/oauth/callback';

describe('bank sign-in return', () => {
  let server;
  let port;
  let memberIds;
  let parentCookie;
  let kidCookie;
  const savedEnv = {};

  // Host and path separately, so the path is sent exactly as written.
  const request = (method, path, { cookie, json } = {}) => new Promise((resolve, reject) => {
    const body = json === undefined ? null : JSON.stringify(json);
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== null) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
  const sessionRow = async (token = TOKEN) => (await pool.query('SELECT id, oauth_state_id, status FROM link_sessions WHERE link_token = $1', [token])).rows[0];
  const pending = (token) => pool.query("INSERT INTO link_sessions (link_token, status, owner, expires_at) VALUES ($1, 'pending', 'Return Parent', now() + interval '4 hours')", [token]);

  before(async () => {
    for (const key of ['APP_URL', 'PLAID_OAUTH_REDIRECT_URI']) savedEnv[key] = process.env[key];
    const insert = "INSERT INTO family_members (name, role, avatar_emoji, color, passphrase_hash) VALUES ($1, $2, 'x', '#111111', $3) RETURNING id";
    const { rows: [parent] } = await pool.query(insert, ['Return Parent', 'parent', hashPassphrase('a-test-passphrase')]);
    const { rows: [kid] } = await pool.query(insert, ['Return Kid', 'kid', null]);
    memberIds = [parent.id, kid.id];
    parentCookie = `fp_session=${(await createSession(parent.id)).token}`;
    kidCookie = `fp_session=${(await createSession(kid.id)).token}`;
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    ({ port } = server.address());
  });

  beforeEach(async () => {
    process.env.APP_URL = APP_URL;
    process.env.PLAID_OAUTH_REDIRECT_URI = REDIRECT;
    // Resuming looks for the one link in progress, so no other file's sessions may be pending here.
    await pool.query('DELETE FROM link_sessions');
    await pending(TOKEN);
  });

  after(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM link_sessions WHERE link_token = ANY($1)', [[TOKEN, OTHER_TOKEN]]);
    await pool.query('DELETE FROM sessions WHERE member_id = ANY($1)', [memberIds]);
    await pool.query('DELETE FROM family_members WHERE id = ANY($1)', [memberIds]);
    await pool.end();
  });

  it('the public callback only sends the browser to Pulse: no token, no write, no sign-in needed', async () => {
    const res = await request('GET', '/oauth/callback?oauth_state_id=state-from-plaid');
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `${APP_URL}/oauth-return.html?oauth_state_id=state-from-plaid`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(!res.text.includes(TOKEN));
    assert.equal((await sessionRow()).oauth_state_id, null, 'nothing is bound');
  });

  it('passes Plaid\'s query on exactly as it came', async () => {
    const res = await request('GET', '/oauth/callback?oauth_state_id=a%2Fb-c&extra=1');
    assert.equal(res.headers.location, `${APP_URL}/oauth-return.html?oauth_state_id=a%2Fb-c&extra=1`);
  });

  it('without APP_URL it stays on the address it came in on', async () => {
    delete process.env.APP_URL;
    const res = await request('GET', '/oauth/callback?oauth_state_id=s1');
    assert.equal(res.headers.location, '../oauth-return.html?oauth_state_id=s1');
  });

  it('refuses a return it can\'t finish', async () => {
    for (const path of ['/oauth/callback', '/oauth/callback?oauth_state_id=', '/oauth/callback?oauth_state_id=a&oauth_state_id=b',
      '/oauth/callback?oauth_state_id=a%00b', '/oauth/callback?oauth_state_id=a%0Ab',
      `/oauth/callback?oauth_state_id=${'a'.repeat(257)}`, `/oauth/callback?oauth_state_id=a&pad=${'b'.repeat(2048)}`]) {
      const res = await request('GET', path);
      assert.equal(res.status, 400, path.slice(0, 60));
      assert.equal(res.headers.location, undefined);
    }
  });

  it('takes no POST', async () => {
    const res = await request('POST', '/oauth/callback', { json: { public_token: 'public-stranger', oauth_state_id: 'stranger' } });
    assert.equal(res.status, 404);
    const row = await sessionRow();
    assert.equal(row.oauth_state_id, null);
    assert.equal(row.status, 'pending');
  });

  it('the return page is served without sign-in and holds nothing', async () => {
    const page = await request('GET', '/oauth-return.html?oauth_state_id=state-from-plaid');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('oauth-return.js'));
    assert.ok(page.text.includes('<meta name="referrer" content="no-referrer">'));
    assert.ok(!page.text.includes(TOKEN));
    assert.equal((await request('GET', '/oauth-return.js')).status, 200);
    // The old return page, which created a new link session as soon as it opened, is gone.
    assert.equal((await request('GET', '/oauth-callback.html')).status, 404);
    assert.equal((await sessionRow()).oauth_state_id, null);
  });

  it('resuming needs a signed-in parent', async () => {
    const query = { query: 'oauth_state_id=state-from-plaid' };
    const stranger = await request('POST', '/api/link/oauth-resume', { json: query });
    assert.equal(stranger.status, 401);
    assert.ok(!stranger.text.includes(TOKEN));
    const kid = await request('POST', '/api/link/oauth-resume', { cookie: kidCookie, json: query });
    assert.equal(kid.status, 403);
    assert.ok(!kid.text.includes(TOKEN));
    assert.equal((await sessionRow()).oauth_state_id, null);
  });

  it('a parent resumes the pending link, with the exact address Plaid sent the browser to, and nothing is written', async () => {
    const query = 'oauth_state_id=state-from-plaid&extra=1';
    const res = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const row = await sessionRow();
    assert.deepEqual(JSON.parse(res.text), { link_token: TOKEN, link_session_id: row.id, received_redirect_uri: `${REDIRECT}?${query}` });
    assert.deepEqual({ bound: row.oauth_state_id, status: row.status }, { bound: null, status: 'pending' });
    // A reload of Plaid's step finds the same session.
    assert.equal((await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query } })).status, 200);
  });

  it('a return someone else made up changes nothing, so the real one still finishes', async () => {
    // A link to the return page with any oauth_state_id makes the parent's browser post it. Only Plaid can tell it's
    // fake, so the resume must not store it.
    const forged = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query: 'oauth_state_id=made-up-by-a-stranger' } });
    assert.equal(forged.status, 200);
    assert.deepEqual(await sessionRow().then((r) => [r.oauth_state_id, r.status]), [null, 'pending']);
    const real = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query: 'oauth_state_id=state-from-plaid' } });
    assert.equal(real.status, 200);
    assert.equal(JSON.parse(real.text).link_token, TOKEN);
  });

  it('nothing in progress: nothing to resume', async () => {
    await pool.query("UPDATE link_sessions SET status = 'exchanged' WHERE link_token = $1", [TOKEN]);
    const res = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query: 'oauth_state_id=s0' } });
    assert.equal(res.status, 409);
    assert.ok(!res.text.includes(TOKEN));
  });

  it('two links in progress: Pulse won\'t guess', async () => {
    await pending(OTHER_TOKEN);
    const res = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query: 'oauth_state_id=s2' } });
    assert.equal(res.status, 409);
    assert.equal((await sessionRow()).oauth_state_id, null);
    assert.equal((await sessionRow(OTHER_TOKEN)).oauth_state_id, null);
  });

  it('refuses a resume it can\'t finish', async () => {
    for (const json of [{}, { query: '' }, { query: 'x=1' }, { query: 42 }, { query: 'oauth_state_id=a&oauth_state_id=b' }, { query: 'oauth_state_id=a b' }]) {
      const res = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json });
      assert.equal(res.status, 400, JSON.stringify(json));
    }
    delete process.env.PLAID_OAUTH_REDIRECT_URI;
    const res = await request('POST', '/api/link/oauth-resume', { cookie: parentCookie, json: { query: 'oauth_state_id=s3' } });
    assert.equal(res.status, 409);
    assert.equal((await sessionRow()).oauth_state_id, null);
  });
});
