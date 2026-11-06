'use strict';

require('dotenv').config();
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { createSession } = require('../lib/auth');
const { createSuiteIdentity, publicPath } = require('../lib/suite-identity');
const { app, setSuiteIdentityForTests, bootstrapState } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SOCKET = 'unix:/run/sovereign-apps/family-pulse/app.sock';
const HOST = 'smith-pulse.example-tailnet.ts.net';
const ORIGIN = `https://${HOST}`;
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/pulse/` };
const noSnapshot = { current: () => ({ ok: false, reason: 'missing', message: 'no snapshot' }) };
const unlinked = { findLinked: async () => null };

// A directory snapshot as the library hands it over: members by stable user ID.
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['family-pulse'], role: 'parent', ...member }));
  return { current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const PARENT = { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'A Parent' };
const KID = { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'A Kid', role: 'kid' };
const NEW_PARENT = { userId: 'u-new-parent', memberId: 'm_new_parent', login: 'new-parent@example.com', name: 'New Parent' };
const NEW_KID = { userId: 'u-new-kid', memberId: 'm_new_kid', login: 'new-kid@example.com', name: 'New Kid', role: 'kid' };
const NO_ACCESS = { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'No Access', apps: ['family-plan'] };
const DIRECTORY = [PARENT, KID, NEW_PARENT, NEW_KID, NO_ACCESS];

const as = (member) => ({ 'x-sovereign-user-id': member.userId, 'x-sovereign-login': member.login });
// What a browser sends for a page's own fetch.
const OWN_PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const NAVIGATION = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const JSON_WRITE = { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/json' };

describe('Suite identity (tailnet mode)', () => {
  let server;
  let base;
  let parentRow;
  let kidRow;
  let passphrases;

  // Plain http, not fetch: fetch sets Sec-Fetch-Mode itself, and these tests are about exactly what a browser sends.
  const send = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([key, value]) => [key, String(value)])), text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const get = (path, headers) => send('GET', path, headers);
  const tailnet = (members = DIRECTORY) => setSuiteIdentityForTests(TAILNET, { reader: snapshotOf(members) });

  before(async () => {
    // A tailnet household has no passphrases, which is what turns the local checks off, so that's what is tested.
    ({ rows: passphrases } = await pool.query('SELECT id, passphrase_hash FROM family_members WHERE passphrase_hash IS NOT NULL'));
    await pool.query('UPDATE family_members SET passphrase_hash = NULL');
    const insert = `INSERT INTO family_members (name, role, avatar_emoji, color, suite_member_id) VALUES ($1, $2, '🙂', '#123456', $3) RETURNING *`;
    ({ rows: [parentRow] } = await pool.query(insert, ['Suite Parent', 'parent', PARENT.memberId]));
    ({ rows: [kidRow] } = await pool.query(insert, ['Suite Kid', 'kid', KID.memberId]));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => setSuiteIdentityForTests({}));

  after(async () => {
    setSuiteIdentityForTests({});
    await new Promise((resolve) => server.close(resolve));
    await pool.query('DELETE FROM sessions WHERE member_id = ANY($1)', [[parentRow.id, kidRow.id]]);
    await pool.query('DELETE FROM family_members WHERE id = ANY($1)', [[parentRow.id, kidRow.id]]);
    for (const { id, passphrase_hash: hash } of passphrases) await pool.query('UPDATE family_members SET passphrase_hash = $1 WHERE id = $2', [hash, id]);
    await pool.end();
  });

  it('no SOVEREIGN_AUTH_MODE means local: installs from before Home Base set one keep their own sign-in', () => {
    assert.equal(createSuiteIdentity({}).mode, 'local');
    assert.equal(createSuiteIdentity({ SOVEREIGN_AUTH_MODE: 'local' }).mode, 'local');
    assert.equal(createSuiteIdentity({}).tailnet, false);
  });

  it('a configuration the app cannot trust refuses to start', () => {
    for (const mode of ['', ' ', 'Tailnet', 'off', 'true']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_AUTH_MODE: mode }, unlinked), /SOVEREIGN_AUTH_MODE/, `mode '${mode}'`);
    }
    // Identity headers are trusted only on the app's socket, which only nginx can reach.
    for (const listen of [undefined, '', '127.0.0.1:3003']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_LISTEN: listen }, unlinked), /SOVEREIGN_LISTEN/);
    }
    for (const uid of [undefined, '', '0', '-1', '01', '1e3', '4294967295', '99999999999', 'homebase']) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_HOMEBASE_UID: uid }, unlinked), /SOVEREIGN_HOMEBASE_UID/, `uid '${uid}'`);
    }
    for (const url of [undefined, '', 'pulse', `http://${HOST}/pulse/`]) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, { ...unlinked, reader: noSnapshot }), /APP_PUBLIC_URL/, `url '${url}'`);
    }
    // Redirects are built on the path, so it must stay on this host.
    for (const url of [`${ORIGIN}//evil.example/`, `${ORIGIN}/pulse//x/`, `${ORIGIN}/pu%2Flse/`]) {
      assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, { ...unlinked, reader: noSnapshot }), /APP_PUBLIC_URL/, `url '${url}'`);
    }
    assert.equal(publicPath(`${ORIGIN}/pulse`), '/pulse/');
    assert.throws(() => createSuiteIdentity(TAILNET, { reader: noSnapshot }), /find linked members/);
    assert.equal(createSuiteIdentity(TAILNET, { ...unlinked, reader: noSnapshot }).mode, 'tailnet');
  });

  it('with no passphrases anywhere, a kid still reaches no parent route: tailnet mode always requires a member', async () => {
    tailnet();
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM family_members WHERE passphrase_hash IS NOT NULL');
    assert.equal(count, 0);
    const kid = { ...as(KID), ...OWN_PAGE };
    for (const path of ['/api/items', '/api/accounts', '/api/transactions', '/api/status', '/api/budget', '/api/anomalies', '/api/magic/digest', '/api/auth/members', '/api/auth/account-members', '/api/bootstrap', '/api/recurring', '/api/reports/spending-burn']) {
      const answer = await get(path, kid);
      assert.equal(answer.status, 403, path);
      assert.equal((await answer.json()).code, 'parent_only', path);
    }
    assert.equal((await send('POST', '/api/sync', { ...as(KID), ...JSON_WRITE }, '{}')).status, 403);
    assert.equal((await send('PUT', `/api/categories/1`, { ...as(KID), ...JSON_WRITE }, '{}')).status, 403);
    // And with nobody named, nothing at all.
    assert.equal((await get('/api/accounts', OWN_PAGE)).status, 403);
  });

  it('a kid reaches their own dashboard and pages; other pages send them back to it', async () => {
    tailnet();
    const kid = { ...as(KID), ...OWN_PAGE };
    const me = await get('/api/auth/me', kid);
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.id, kidRow.id);
    assert.equal(body.role, 'kid');
    assert.equal((await get('/api/kids/dashboard', kid)).status, 200);
    assert.equal((await get('/api/categories', kid)).status, 200);
    const page = { ...as(KID), ...NAVIGATION };
    assert.equal((await get('/kids.html', page)).status, 200);
    assert.equal((await get('/kids/suite-kid', page)).status, 200);
    for (const path of ['/', '/index.html', '/accounts.html', '/settings.html', '/admin.html', '/setup', '/link', '/login.html', '/oauth/callback']) {
      const answer = await get(path, page);
      assert.equal(answer.status, 303, path);
      assert.equal(answer.headers.get('location'), '/pulse/kids.html', path);
    }
  });

  it('the directory decides the role, never the row', async () => {
    // The row says kid, the directory parent.
    tailnet([{ ...KID, role: 'parent' }]);
    const promoted = await get('/api/auth/me', { ...as(KID), ...OWN_PAGE });
    assert.equal((await promoted.json()).role, 'parent');
    assert.equal((await get('/api/accounts', { ...as(KID), ...OWN_PAGE })).status, 200);
    // The row says parent, the directory kid.
    tailnet([{ ...PARENT, role: 'kid' }]);
    const demoted = await get('/api/auth/me', { ...as(PARENT), ...OWN_PAGE });
    assert.equal((await demoted.json()).role, 'kid');
    assert.equal((await get('/api/accounts', { ...as(PARENT), ...OWN_PAGE })).status, 403);
  });

  it('anyone the directory does not admit is refused, with a page saying who to ask', async () => {
    tailnet();
    const refusal = async (headers, status, code) => {
      const api = await get('/api/auth/me', { ...headers, ...OWN_PAGE });
      assert.equal(api.status, status);
      assert.equal((await api.json()).code, code);
      const page = await get('/accounts.html', { ...headers, ...NAVIGATION });
      assert.equal(page.status, status);
      assert.match(page.headers.get('content-type'), /html/);
      assert.equal(page.headers.get('cache-control'), 'no-store');
    };
    await refusal({}, 403, 'not_member');
    await refusal(as({ userId: 'u-stranger', login: 'stranger@example.com' }), 403, 'not_member');
    await refusal(as(NO_ACCESS), 403, 'not_member');
    // A mismatched login: nginx names one member, the login another.
    await refusal({ 'x-sovereign-user-id': PARENT.userId, 'x-sovereign-login': KID.login }, 403, 'not_member');
    await refusal(as(NEW_KID), 403, 'not_linked');
    // A device with a tag has no identity, even listed in the directory.
    const tagged = { userId: 'u-tag', memberId: 'm_tag', login: 'tagged-devices', name: 'A Server' };
    tailnet([...DIRECTORY, tagged]);
    await refusal(as(tagged), 403, 'not_member');
    assert.ok(!createSuiteIdentity(TAILNET, { ...unlinked, reader: snapshotOf([...DIRECTORY, tagged]) }).directory().some((member) => member.memberId === 'm_tag'));
    // No snapshot: can't tell, so nobody gets in.
    setSuiteIdentityForTests(TAILNET, { reader: noSnapshot });
    await refusal(as(PARENT), 503, 'directory');
  });

  it('a parent nobody has linked is sent to the link page, and reaches nothing else', async () => {
    tailnet();
    const parent = { ...as(NEW_PARENT), ...OWN_PAGE };
    const page = await get('/accounts.html', { ...as(NEW_PARENT), ...NAVIGATION });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/pulse/link');
    assert.equal((await get('/api/accounts', parent)).status, 403);
    assert.equal((await get('/api/auth/me', parent)).status, 403);
    // Setup is theirs while there's no household; bootstrap itself refuses once there is one.
    assert.equal((await get('/api/bootstrap', parent)).status, 200);
    assert.equal((await send('POST', '/api/bootstrap/household', { ...as(NEW_PARENT), ...JSON_WRITE }, JSON.stringify({ members: [{ name: 'x', role: 'parent' }] }))).status, 409);
  });

  it('a linked parent gets everything a parent does, with no passphrase', async () => {
    tailnet();
    const parent = { ...as(PARENT), ...OWN_PAGE };
    const me = await (await get('/api/auth/me', parent)).json();
    assert.equal(me.id, parentRow.id);
    assert.equal(me.role, 'parent');
    for (const path of ['/api/accounts', '/api/items', '/api/auth/members']) assert.equal((await get(path, parent)).status, 200, path);
    assert.equal((await get('/accounts.html', { ...as(PARENT), ...NAVIGATION })).status, 200);
    const login = await get('/login.html', { ...as(PARENT), ...NAVIGATION });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/pulse/');
    assert.equal((await bootstrapState()).bootstrap.needs_auth, false);
  });

  it('local sign-in means nothing: a session is ignored, and login and passphrase changes are refused', async () => {
    const { token } = await createSession(parentRow.id);
    const cookie = { cookie: `fp_session=${token}` };
    assert.equal((await get('/api/accounts', { ...cookie, ...OWN_PAGE })).status, 200, 'with no passphrases, local mode lets anyone in, which is the check tailnet mode has to replace');
    tailnet();
    assert.equal((await get('/api/accounts', { ...cookie, ...OWN_PAGE })).status, 403, 'a parent\'s session opens nothing by itself');
    assert.equal((await get('/api/accounts', { ...as(KID), ...cookie, ...OWN_PAGE })).status, 403, 'and lifts no kid');
    const stillKid = await get('/api/auth/me', { ...as(KID), ...cookie, ...OWN_PAGE });
    assert.equal((await stillKid.json()).id, kidRow.id, 'not even on a route the kid may use');
    const login = await send('POST', '/api/auth/login', { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ member_id: parentRow.id, passphrase: 'x' }));
    assert.equal(login.status, 409);
    assert.equal((await login.json()).code, 'tailnet_mode');
    assert.equal((await send('PUT', '/api/auth/passphrase', { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ member_id: parentRow.id, passphrase: 'a-new-passphrase' }))).status, 409);
    const { rows: [saved] } = await pool.query('SELECT passphrase_hash FROM family_members WHERE id = $1', [parentRow.id]);
    assert.equal(saved.passphrase_hash, null, 'unchanged');
  });

  it('writes are JSON from this origin only, and only upload routes take a file', async () => {
    tailnet();
    const parent = as(PARENT);
    const refused = async (path, headers, reason) => {
      const answer = await send('POST', path, { ...parent, ...headers }, '{}');
      assert.equal(answer.status, 403, JSON.stringify(headers));
      assert.equal((await answer.json()).reason, reason);
    };
    await refused('/api/sync', { ...OWN_PAGE, 'content-type': 'application/json' }, 'origin_missing');
    await refused('/api/sync', { ...OWN_PAGE, origin: 'https://smith-home.example-tailnet.ts.net', 'content-type': 'application/json' }, 'origin_mismatch');
    await refused('/api/sync', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'content_type');
    await refused('/api/sync', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, 'content_type');
    await refused('/api/sync', { ...OWN_PAGE, origin: ORIGIN }, 'content_type');
    // A sibling hostname is the same site, and refused all the same.
    await refused('/api/sync', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: ORIGIN, 'content-type': 'application/json' }, 'not_same_origin');
    await refused('/api/sync', { 'content-type': 'application/json', origin: ORIGIN }, 'fetch_metadata_missing');
    // An upload route takes a file from this origin, and still nothing from any other.
    const upload = { ...parent, ...OWN_PAGE, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' };
    assert.notEqual((await send('POST', '/api/import/upload', upload, '--x--\r\n')).status, 403);
    await refused('/api/import/upload', { ...OWN_PAGE, origin: 'https://smith-home.example-tailnet.ts.net', 'content-type': 'multipart/form-data; boundary=x' }, 'origin_mismatch');
    await refused('/api/import/upload', { ...OWN_PAGE, origin: ORIGIN, 'content-type': 'text/plain' }, 'content_type');
  });

  it('other sites and sibling hostnames read nothing: only the app\'s own pages and top-level navigation get through', async () => {
    tailnet();
    const parent = as(PARENT);
    for (const site of ['same-site', 'cross-site']) {
      for (const headers of [{ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }]) {
        const answer = await get('/api/accounts', { ...parent, 'sec-fetch-site': site, ...headers });
        assert.equal(answer.status, 403);
        assert.equal((await answer.json()).reason, 'not_same_origin');
      }
    }
    assert.equal((await get('/api/accounts', parent)).status, 403, 'no fetch metadata');
    assert.match((await get('/accounts.html', { ...parent, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).headers.get('content-type'), /html/, 'a link to a page still opens it');
  });

  it('a navigation can\'t reach the API, so a sibling\'s link can\'t generate a report: only an attachment download opens that way', async () => {
    tailnet();
    for (const member of [PARENT, KID]) {
      for (const path of ['/api/magic/digest', '/api/magic/monthly', '/api/kids/report-card', '/api/accounts', '/api/auth/me']) {
        const answer = await get(path, { ...as(member), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
        assert.equal(answer.status, 403, path);
        assert.equal((await answer.json()).code, 'not_a_page', path);
      }
    }
    const download = await get('/api/transaction-attachments/999999999/download', { ...as(PARENT), ...NAVIGATION });
    assert.equal(download.status, 404, 'reaches its route, which finds nothing');
  });

  it('Home Base\'s probes and the page assets need no member and no fetch metadata; assets carry no data', async () => {
    tailnet();
    assert.equal((await get('/api/health')).status, 200);
    assert.ok([200, 503].includes((await get('/api/ready')).status));
    assert.equal((await get('/style.css', OWN_PAGE)).status, 200);
    assert.equal((await get('/accounts.html', OWN_PAGE)).status, 403, 'a page is not an asset');
    assert.equal((await get('/api/x.js', OWN_PAGE)).status, 403, 'nor is an API path that looks like one');
  });
});
