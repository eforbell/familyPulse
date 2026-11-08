'use strict';

// Bank links in tailnet mode (wire contract, section 10; D22). Starting a link records the member, this hostname and a
// correlation value only the starting browser holds, in a __Host- cookie for ten minutes. The bank's return needs
// nothing and holds nothing. Resuming finds the link this member started in this browser, and finishing takes the link
// once and refuses anyone but the member who started it.
require('dotenv').config();
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { signToken } = require('sovereign-auth');
const { Pool } = require('pg');
const { app, setSuiteIdentityForTests } = require('../server');
const { createSession } = require('../lib/auth');
const plaid = require('../lib/plaid-client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SOCKET = 'unix:/run/sovereign-apps/family-pulse/app.sock';
const HOST = 'smith-pulse.example-tailnet.ts.net';
const ORIGIN = `https://${HOST}`;
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/pulse/` };
const REDIRECT = `${ORIGIN}/pulse/oauth/callback`;
const SIGNING = crypto.generateKeyPairSync('ed25519');
const HOUSEHOLD = 'test-household';

function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['family-pulse'], role: 'parent', ...member }));
  const snapshot = { household: HOUSEHOLD, globalEpoch: 1, keys: new Map([['test-key', SIGNING.publicKey]]), members: list, byUserId: new Map(list.map((member) => [member.userId, member])) };
  return { current: () => ({ ok: true, snapshot }) };
}
const PARENT = { userId: 'u-oauth-parent', memberId: 'm_oauth_parent', login: 'parent@example.com', name: 'A Parent' };
const OTHER_PARENT = { userId: 'u-oauth-other', memberId: 'm_oauth_other', login: 'other@example.com', name: 'Other Parent' };
const KID = { userId: 'u-oauth-kid', memberId: 'm_oauth_kid', login: 'kid@example.com', name: 'A Kid', role: 'kid' };

// Home Base's passkey check on this hostname, `age` seconds ago (wire contract, section 7).
function passkeyCookie(member, age = 0) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { typ: 'assurance', kid: 'test-key', household: HOUSEHOLD, aud: HOST, sub: member.userId, sid: 's1', cred: 'c1', kind: 'synced', epoch: 1, global_epoch: 1, auth_time: now - age, iat: now - age, exp: now - age + 31 * 86400 };
  return `__Host-sv_assurance=${signToken(payload, SIGNING.privateKey)}`;
}
const identity = (member) => ({ 'x-sovereign-user-id': member.userId, 'x-sovereign-login': member.login });
// A parent with a passkey check from just now, plus any other cookies.
const as = (member, ...cookies) => ({ ...identity(member), cookie: [member.role === 'kid' ? null : passkeyCookie(member), ...cookies].filter(Boolean).join('; ') });
const OWN_PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const JSON_WRITE = { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/json' };
const FROM_BANK = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

describe('bank links in tailnet mode', () => {
  let server;
  let base;
  let rows;
  let itemId;
  let savedRedirect;
  let exchanges;
  const stubs = {};

  const send = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* a page */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const post = (path, headers, body = {}) => send('POST', path, { ...JSON_WRITE, ...headers }, JSON.stringify(body));
  const tailnet = () => setSuiteIdentityForTests(TAILNET, { reader: snapshotOf([PARENT, OTHER_PARENT, KID]) });
  const oauthCookieOf = (res) => (res.headers['set-cookie'] || []).find((line) => line.startsWith('__Host-sv_oauth='));
  const cookiePair = (line) => line.split(';')[0];
  const session = async (id) => (await pool.query('SELECT * FROM link_sessions WHERE id = $1', [id])).rows[0];
  // A link this member starts from Settings: its id, and the cookie its browser now holds.
  async function start(member = PARENT) {
    const res = await post('/api/link/create-token', as(member), { owner: 'A Parent' });
    assert.equal(res.status, 200, res.text);
    return { id: res.json.link_session_id, token: res.json.link_token, cookie: cookiePair(oauthCookieOf(res)) };
  }
  const resume = (member, cookie, query = 'oauth_state_id=from-plaid') => post('/api/link/oauth-resume', as(member, cookie), { query });
  const refused = (res, status, reason, label) => {
    assert.equal(res.status, status, `${label}: ${res.text}`);
    assert.deepEqual(res.json, { error: 'oauth_refused', reason }, label);
  };

  before(async () => {
    savedRedirect = process.env.PLAID_OAUTH_REDIRECT_URI;
    process.env.PLAID_OAUTH_REDIRECT_URI = REDIRECT;
    const insert = `INSERT INTO family_members (name, role, avatar_emoji, color, suite_member_id) VALUES ($1, $2, '🙂', '#123456', $3) RETURNING id`;
    rows = [];
    for (const [name, role, member] of [['OAuth Parent', 'parent', PARENT], ['OAuth Other', 'parent', OTHER_PARENT], ['OAuth Kid', 'kid', KID]]) {
      rows.push((await pool.query(insert, [name, role, member.memberId])).rows[0].id);
    }
    ({ rows: [{ id: itemId }] } = await pool.query("INSERT INTO items (access_token, item_id, institution_id, institution_name) VALUES ('access-tailnet-oauth', 'item-tailnet-oauth', 'ins_x', 'Tailnet Bank') RETURNING id"));
    for (const key of ['createLinkToken', 'exchangePublicToken', 'getItemInfo']) stubs[key] = plaid[key];
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM link_sessions');
    exchanges = [];
    let n = 0;
    plaid.createLinkToken = async () => ({ link_token: `link-sandbox-tailnet-${++n}`, expiration: '2099-01-01T00:00:00Z' });
    // Reaching Plaid is what these tests look for, so the stand-in records the call and stops there.
    plaid.exchangePublicToken = async (publicToken) => { exchanges.push(publicToken); throw new Error('stand-in: reached Plaid'); };
    plaid.getItemInfo = async () => { exchanges.push('refresh'); throw new Error('stand-in: reached Plaid'); };
    tailnet();
  });

  afterEach(() => {
    setSuiteIdentityForTests({});
    Object.assign(plaid, stubs);
  });

  after(async () => {
    setSuiteIdentityForTests({});
    if (savedRedirect === undefined) delete process.env.PLAID_OAUTH_REDIRECT_URI;
    else process.env.PLAID_OAUTH_REDIRECT_URI = savedRedirect;
    await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM link_sessions');
    await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
    await pool.query('DELETE FROM sessions WHERE member_id = ANY($1)', [rows]);
    await pool.query('DELETE FROM family_members WHERE id = ANY($1)', [rows]);
    await pool.end();
  });

  it('starting a link binds it to this member, this hostname and this browser, for ten minutes', async () => {
    for (const [path, body] of [['/api/link/create-token', { owner: 'A Parent' }], ['/api/link/update-token', { item_id: itemId }], ['/api/link/create-liability-upgrade-token', { item_id: itemId }]]) {
      const res = await post(path, as(PARENT), body);
      assert.equal(res.status, 200, `${path}: ${res.text}`);
      const line = oauthCookieOf(res);
      assert.ok(line, `${path} sets the cookie`);
      const value = cookiePair(line).slice('__Host-sv_oauth='.length);
      assert.match(value, /^[A-Za-z0-9_-]{43}$/, '32 random bytes');
      assert.deepEqual(line.split('; ').slice(1).sort(), ['HttpOnly', 'Max-Age=600', 'Path=/', 'SameSite=Strict', 'Secure']);
      const row = await session(res.json.link_session_id);
      assert.equal(row.started_by, PARENT.userId, path);
      assert.equal(row.hostname, HOST, path);
      assert.equal(row.correlation_hash, crypto.createHash('sha256').update(value).digest('base64url'), 'only a hash of it is kept');
      assert.ok(!JSON.stringify(row).includes(value), 'never the value itself');
    }
    const two = [await start(), await start()];
    assert.notEqual(two[0].cookie, two[1].cookie, 'every start a new value');
  });

  it('local mode binds nothing and sets no cookie', async () => {
    setSuiteIdentityForTests({});
    const signedIn = `fp_session=${(await createSession(rows[0])).token}`;
    const res = await send('POST', '/api/link/create-token', { 'content-type': 'application/json', cookie: signedIn }, '{}');
    assert.equal(res.status, 200, res.text);
    assert.equal(oauthCookieOf(res), undefined);
    const row = await session(res.json.link_session_id);
    assert.deepEqual([row.started_by, row.hostname, row.correlation_hash], [null, null, null]);
  });

  it('the bank\'s return needs no member and no passkey, and lands on the address Home Base publishes', async () => {
    const query = 'oauth_state_id=from-plaid';
    // Through a public tunnel (no member at all), and from the bank's site with no passkey cookie.
    for (const headers of [FROM_BANK, { ...FROM_BANK, ...identity(PARENT) }]) {
      const res = await send('GET', `/oauth/callback?${query}`, headers);
      assert.equal(res.status, 303, res.text);
      assert.equal(res.headers.location, `${ORIGIN}/pulse/oauth-return.html?${query}`);
      assert.equal(res.headers['set-cookie'], undefined, 'and sets nothing');
      const page = await send('GET', `/oauth-return.html?${query}`, headers);
      assert.equal(page.status, 200);
      assert.match(page.text, /passkey\.js/, 'the page can ask for a passkey check');
      assert.doesNotMatch(page.text, /link-sandbox|oauth_refused/);
    }
    // Only the exact spellings: any other is checked as usual.
    for (const path of ['/OAuth/callback', '/oauth/callback/', '/%6Fauth/callback', '/oauth%2Fcallback', '/oauth-return.html/', '/OAuth-Return.html', '/oauth%2Dreturn.html']) {
      assert.equal((await send('GET', `${path}?${query}`, FROM_BANK)).status, 403, path);
    }
    // A HEAD from the page's own origin answers as the GET would; from another site only a GET navigation passes the
    // guard. Nothing but a read is exempt.
    assert.equal((await send('HEAD', '/oauth-return.html', OWN_PAGE)).status, 200);
    assert.equal((await send('HEAD', '/oauth-return.html', FROM_BANK)).status, 403);
    const write = await send('POST', '/oauth/callback', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: ORIGIN, 'content-type': 'application/json' }, '{}');
    assert.equal(write.status, 403, 'a write to the callback still needs a member');
    // A sibling hostname's fetch of the page is still refused (resource isolation).
    const sibling = await send('GET', '/oauth-return.html', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' });
    assert.equal(sibling.status, 403);
    assert.equal(sibling.json.reason, 'not_same_origin');
  });

  it('resuming finds the link this member started in this browser, writes nothing, and needs no five-minute check', async () => {
    const mine = await start();
    await start(OTHER_PARENT); // someone else's link in progress, started later
    const before = await session(mine.id);
    // A passkey check from six minutes ago opens Family Pulse but couldn't start a link; it can resume one.
    const res = await post('/api/link/oauth-resume', { ...identity(PARENT), cookie: `${passkeyCookie(PARENT, 6 * 60)}; ${mine.cookie}` }, { query: 'oauth_state_id=from-plaid&x=1' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { link_token: mine.token, link_session_id: mine.id, received_redirect_uri: `${REDIRECT}?oauth_state_id=from-plaid&x=1` });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(await session(mine.id), before, 'nothing written');
    // Without a current passkey check it asks for one (the page's helper runs it), and kids can't resume at all.
    const noCheck = await post('/api/link/oauth-resume', { ...identity(PARENT), cookie: mine.cookie }, { query: 'oauth_state_id=x' });
    assert.equal(noCheck.status, 401);
    assert.equal(noCheck.json.error, 'step_up_required');
    assert.equal(noCheck.json.policy, 'open-documents');
    assert.equal((await resume(KID, mine.cookie)).status, 403);
  });

  it('resuming refuses another browser, another member, an old link, another hostname and a finished one', async () => {
    const mine = await start();
    const value = mine.cookie.slice('__Host-sv_oauth='.length);
    refused(await resume(PARENT, null), 403, 'no_cookie', 'no cookie');
    refused(await resume(PARENT, `${mine.cookie}; ${mine.cookie}`), 403, 'duplicate_cookie', 'two cookies');
    refused(await resume(PARENT, `__HOST-sv_oauth=${value}`), 403, 'no_cookie', 'another spelling');
    refused(await resume(PARENT, '__Host-sv_oauth=short'), 403, 'wrong_correlation', 'not one of ours');
    refused(await resume(PARENT, `__Host-sv_oauth=${crypto.randomBytes(32).toString('base64url')}`), 403, 'unknown_state', 'another browser');
    refused(await resume(OTHER_PARENT, mine.cookie), 403, 'wrong_member', 'another member with this browser\'s cookie');
    assert.equal((await resume(PARENT, mine.cookie)).status, 200, 'the refusals used nothing up');

    await pool.query('UPDATE link_sessions SET hostname = $1 WHERE id = $2', ['smith-home.example-tailnet.ts.net', mine.id]);
    refused(await resume(PARENT, mine.cookie), 403, 'wrong_hostname', 'another hostname');
    await pool.query("UPDATE link_sessions SET hostname = $1, created_at = now() - interval '601 seconds' WHERE id = $2", [HOST, mine.id]);
    refused(await resume(PARENT, mine.cookie), 403, 'expired', 'eleven minutes on');
    await pool.query("UPDATE link_sessions SET created_at = now() - interval '590 seconds' WHERE id = $1", [mine.id]);
    assert.equal((await resume(PARENT, mine.cookie)).status, 200, 'just inside ten minutes');
    await pool.query("UPDATE link_sessions SET status = 'exchanged' WHERE id = $1", [mine.id]);
    refused(await resume(PARENT, mine.cookie), 403, 'unknown_state', 'finished');
    // A link started in local mode, before the switch, has no starter to match.
    await pool.query("UPDATE link_sessions SET status = 'pending', started_by = NULL WHERE id = $1", [mine.id]);
    refused(await resume(PARENT, mine.cookie), 403, 'wrong_member', 'no starter');
    assert.equal((await resume(PARENT, mine.cookie, 'no_state=1')).status, 400, 'a return that isn\'t one');
  });

  it('finishing takes the link once, for the member who started it; anyone else uses nothing up', async () => {
    const mine = await start();
    // Link ids are a plain counter, so a refusal must not use the link up: another member can't burn it.
    refused(await post('/api/link/exchange', as(OTHER_PARENT), { public_token: 'public-other', link_session_id: mine.id }), 403, 'wrong_member', 'another member');
    await pool.query('UPDATE link_sessions SET hostname = $1 WHERE id = $2', ['smith-home.example-tailnet.ts.net', mine.id]);
    refused(await post('/api/link/exchange', as(PARENT), { public_token: 'public-host', link_session_id: mine.id }), 403, 'wrong_hostname', 'another hostname');
    await pool.query('UPDATE link_sessions SET hostname = $1, started_by = NULL WHERE id = $2', [HOST, mine.id]);
    refused(await post('/api/link/exchange', as(PARENT), { public_token: 'public-local', link_session_id: mine.id }), 403, 'wrong_member', 'started in local mode');
    await pool.query('UPDATE link_sessions SET started_by = $1 WHERE id = $2', [PARENT.userId, mine.id]);
    assert.deepEqual(exchanges, [], 'Plaid never asked');
    assert.equal((await session(mine.id)).status, 'pending', 'and nothing was used up');

    const res = await post('/api/link/exchange', as(PARENT), { public_token: 'public-mine', link_session_id: mine.id });
    assert.equal(res.status, 500, 'the starter reaches Plaid (the stand-in stops there)');
    assert.deepEqual(exchanges, ['public-mine']);
    assert.equal((await session(mine.id)).status, 'finishing', 'used up whatever Plaid answered');
    const replay = await post('/api/link/exchange', as(PARENT), { public_token: 'public-again', link_session_id: mine.id });
    assert.equal(replay.status, 404, 'once only');
    assert.deepEqual(exchanges, ['public-mine']);
    assert.equal((await post('/api/link/exchange', as(PARENT), { public_token: 'public-unnamed' })).status, 400, 'the link must be named');
    assert.deepEqual(exchanges, ['public-mine']);
  });

  it('finishing has no ten-minute limit and needs no cookie or five-minute check: a desktop Link popup can take longer', async () => {
    const mine = await start();
    await pool.query("UPDATE link_sessions SET created_at = now() - interval '45 minutes' WHERE id = $1", [mine.id]);
    const res = await post('/api/link/exchange', { ...identity(PARENT), cookie: passkeyCookie(PARENT, 40 * 60) }, { public_token: 'public-late', link_session_id: mine.id });
    assert.equal(res.status, 500, `the starter reaches Plaid (the stand-in stops there): ${res.text}`);
    assert.deepEqual(exchanges, ['public-late']);
  });

  it('every finishing answer clears the cookie, refusals and malformed requests included', async () => {
    const CLEARED = '__Host-sv_oauth=; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=0';
    const mine = await start();
    const answers = {
      'no public token': await post('/api/link/exchange', as(PARENT), { link_session_id: mine.id }),
      'no link named': await post('/api/link/exchange', as(PARENT), { public_token: 'p' }),
      'another member': await post('/api/link/exchange', as(OTHER_PARENT), { public_token: 'p', link_session_id: mine.id }),
      'complete-account-selection without a link': await post('/api/link/complete-account-selection', as(PARENT), {}),
      'complete-liability-upgrade without a link': await post('/api/link/complete-liability-upgrade', as(PARENT), {}),
      'the starter': await post('/api/link/exchange', as(PARENT), { public_token: 'p', link_session_id: mine.id }),
    };
    for (const [label, res] of Object.entries(answers)) assert.ok((res.headers['set-cookie'] || []).includes(CLEARED), label);
  });

  it('two finishes at once: one reaches Plaid', async () => {
    const mine = await start();
    const both = await Promise.all([1, 2].map((n) => post('/api/link/exchange', as(PARENT), { public_token: `public-${n}`, link_session_id: mine.id })));
    assert.deepEqual(both.map((res) => res.status).sort(), [404, 500]);
    assert.equal(exchanges.length, 1);
  });

  it('finishing an update takes the link the same way', async () => {
    const res = await post('/api/link/create-liability-upgrade-token', as(PARENT), { item_id: itemId });
    const id = res.json.link_session_id;
    refused(await post('/api/link/complete-liability-upgrade', as(OTHER_PARENT), { link_session_id: id }), 403, 'wrong_member', 'another member');
    assert.deepEqual(exchanges, []);
    assert.equal((await session(id)).status, 'pending', 'nothing used up');
    const mine = await post('/api/link/create-account-selection-token', as(PARENT), { item_id: itemId });
    assert.equal(mine.status, 200, mine.text);
    assert.equal((await session(mine.json.link_session_id)).started_by, PARENT.userId, 'account selection binds its starter too');
    refused(await post('/api/link/complete-account-selection', as(OTHER_PARENT), { link_session_id: mine.json.link_session_id }), 403, 'wrong_member', 'another member');
    const upgrade = (await post('/api/link/create-liability-upgrade-token', as(PARENT), { item_id: itemId })).json.link_session_id;
    assert.equal((await post('/api/link/complete-liability-upgrade', as(PARENT), { link_session_id: upgrade })).status, 500, 'the stand-in stops at Plaid');
    assert.deepEqual(exchanges, ['refresh']);
    assert.equal((await post('/api/link/complete-liability-upgrade', as(PARENT), { link_session_id: upgrade })).status, 404, 'once only');
  });
});
