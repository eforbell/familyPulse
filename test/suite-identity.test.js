'use strict';

require('dotenv').config();
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { signToken } = require('sovereign-auth');
const express = require('express');
const { Pool } = require('pg');
const { createSession } = require('../lib/auth');
const { createSuiteIdentity, publicPath } = require('../lib/suite-identity');
const { createSuiteLinks } = require('../lib/routes/suite-links');
const { app, setSuiteIdentityForTests, bootstrapState } = require('../server');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SOCKET = 'unix:/run/sovereign-apps/family-pulse/app.sock';
const HOST = 'smith-pulse.example-tailnet.ts.net';
const ORIGIN = `https://${HOST}`;
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/pulse/` };
const noSnapshot = { current: () => ({ ok: false, reason: 'missing', message: 'no snapshot' }) };
const unlinked = { findLinked: async () => null };

// Home Base's signing key, which the snapshot publishes and passkey checks are signed with.
const SIGNING = crypto.generateKeyPairSync('ed25519');
const HOUSEHOLD = 'test-household';

// A directory snapshot as the library hands it over: members by stable user ID.
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['family-pulse'], role: 'parent', ...member }));
  const snapshot = { household: HOUSEHOLD, globalEpoch: 1, keys: new Map([['test-key', SIGNING.publicKey]]), members: list, byUserId: new Map(list.map((member) => [member.userId, member])) };
  return { current: () => ({ ok: true, snapshot }) };
}
const PARENT = { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'A Parent' };
const KID = { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'A Kid', role: 'kid' };
const NEW_PARENT = { userId: 'u-new-parent', memberId: 'm_new_parent', login: 'new-parent@example.com', name: 'New Parent' };
const NEW_KID = { userId: 'u-new-kid', memberId: 'm_new_kid', login: 'new-kid@example.com', name: 'New Kid', role: 'kid' };
const NO_ACCESS = { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'No Access', apps: ['family-plan'] };
const DIRECTORY = [PARENT, KID, NEW_PARENT, NEW_KID, NO_ACCESS];

// The cookie Home Base's passkey check sets on this hostname (wire contract, section 7), from a check `age` seconds ago.
function passkeyCookie(member, { age = 0, name = '__Host-sv_assurance', ...claims } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { typ: 'assurance', kid: 'test-key', household: HOUSEHOLD, aud: HOST, sub: member.userId, sid: 's1', cred: 'c1', kind: 'synced', epoch: 1, global_epoch: 1, auth_time: now - age, iat: now - age, exp: now - age + 31 * 86400, ...claims };
  return `${name}=${signToken(payload, SIGNING.privateKey)}`;
}
// Who nginx says is asking. A parent also carries a passkey check from just now, as they would in a browser: what
// happens without one is tested on its own below. Kids have no passkeys.
const as = (member, cookie = member.role === 'kid' ? null : passkeyCookie(member)) => ({ 'x-sovereign-user-id': member.userId, 'x-sovereign-login': member.login, ...(cookie ? { cookie } : {}) });
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
    const picker = await get('/api/categories', kid);
    assert.equal(picker.status, 200);
    for (const category of await picker.json()) assert.deepEqual(Object.keys(category).sort(), ['color', 'id', 'name'], 'no budgets or household counts');
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
    // The row says kid, the directory parent: a parent, who opens Family Pulse with a passkey like any other.
    tailnet([{ ...KID, role: 'parent' }]);
    assert.equal((await get('/api/accounts', { ...as(KID), ...OWN_PAGE })).status, 401, 'no passkey check yet');
    const promoted = await get('/api/auth/me', { ...as(KID, passkeyCookie(KID)), ...OWN_PAGE });
    assert.equal((await promoted.json()).role, 'parent');
    assert.equal((await get('/api/accounts', { ...as(KID, passkeyCookie(KID)), ...OWN_PAGE })).status, 200);
    // The row says parent, the directory kid: not parent access, and not that parent's data on a kid's pages either.
    tailnet([{ ...PARENT, role: 'kid' }]);
    for (const path of ['/api/auth/me', '/api/kids/dashboard', '/api/kids/report-card', '/api/categories', '/api/accounts']) {
      const answer = await get(path, { ...as(PARENT), ...OWN_PAGE });
      assert.equal(answer.status, 403, path);
      assert.equal((await answer.json()).code, 'stale_link', path);
    }
    const page = await get('/kids.html', { ...as(PARENT), ...NAVIGATION });
    assert.equal(page.status, 403);
    assert.match(page.headers.get('content-type'), /html/);
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
    const setup = await get('/api/bootstrap', parent);
    assert.equal(setup.status, 200);
    assert.deepEqual(Object.keys(await setup.json()).sort(), ['app', 'bootstrap', 'status', 'version'], 'whether setup is needed, and no household counts');
    assert.equal((await send('POST', '/api/bootstrap/household', { ...as(NEW_PARENT), ...JSON_WRITE }, JSON.stringify({ members: [{ name: 'x', role: 'parent' }] }))).status, 409);
  });

  describe('linking household members', () => {
    let spare;
    const putLink = (id, value, member = PARENT) => send('PUT', `/api/suite/links/${id}`, { ...as(member), ...JSON_WRITE }, JSON.stringify({ suite_member_id: value }));
    const code = async (answer) => (await answer.json()).code;

    before(async () => {
      ({ rows: [spare] } = await pool.query(`INSERT INTO family_members (name, role, avatar_emoji, color) VALUES ('Spare Parent', 'parent', '🙂', '#123456') RETURNING *`));
    });
    after(() => pool.query('DELETE FROM family_members WHERE id = $1', [spare.id]));
    afterEach(() => pool.query('UPDATE family_members SET suite_member_id = NULL WHERE id = $1', [spare.id]));

    it('a parent nobody has linked can link themselves, and then gets in', async () => {
      tailnet();
      const parent = { ...as(NEW_PARENT), ...OWN_PAGE };
      const page = await get('/link', { ...as(NEW_PARENT), ...NAVIGATION });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const list = await (await get('/api/suite/links', parent)).json();
      assert.equal(list.you, NEW_PARENT.memberId);
      assert.ok(list.members.some((member) => member.id === spare.id));
      assert.ok(!list.directory.some((person) => person.memberId === NO_ACCESS.memberId), 'only people with access to Family Pulse');
      assert.equal((await get('/api/accounts', parent)).status, 403);
      const linked = await putLink(spare.id, NEW_PARENT.memberId, NEW_PARENT);
      assert.equal(linked.status, 200);
      assert.equal((await linked.json()).suite_member_id, NEW_PARENT.memberId);
      assert.equal((await get('/api/accounts', parent)).status, 200);
      assert.equal((await (await get('/api/auth/me', parent)).json()).id, spare.id);
    });

    it('a link can be cleared, which puts that parent back at the link page', async () => {
      tailnet();
      assert.equal((await putLink(spare.id, NEW_PARENT.memberId)).status, 200);
      assert.equal((await putLink(spare.id, null)).status, 200);
      assert.equal((await get('/api/accounts', { ...as(NEW_PARENT), ...OWN_PAGE })).status, 403);
    });

    it('only someone the directory admits can be linked, and only once', async () => {
      tailnet();
      assert.equal(await code(await putLink(spare.id, 'm_nobody')), 'unknown_member');
      assert.equal(await code(await putLink(spare.id, NO_ACCESS.memberId)), 'unknown_member');
      for (const value of [undefined, 7, {}, '']) assert.equal((await putLink(spare.id, value)).status, 400, JSON.stringify(value));
      const taken = await putLink(spare.id, PARENT.memberId);
      assert.equal(taken.status, 409);
      assert.equal(await code(taken), 'already_linked');
    });

    it('a kid\'s account never takes a parent\'s row, because kid pages show that row\'s data', async () => {
      tailnet();
      const refused = await putLink(spare.id, NEW_KID.memberId);
      assert.equal(refused.status, 400);
      assert.equal(await code(refused), 'role_mismatch');
      const { rows: [row] } = await pool.query('SELECT suite_member_id FROM family_members WHERE id = $1', [spare.id]);
      assert.equal(row.suite_member_id, null);
    });

    it('an unknown member is a 404, even one too large for the column', async () => {
      tailnet();
      for (const id of ['2147483647', '2147483648', '999999999999999999']) {
        const answer = await putLink(id, PARENT.memberId);
        assert.equal(answer.status, 404, id);
        assert.equal(await code(answer), 'not_found', id);
      }
    });

    it('a kid can\'t see or change links, and a row saying parent doesn\'t help', async () => {
      tailnet();
      const kid = { ...as(KID), ...OWN_PAGE };
      assert.equal((await get('/api/suite/links', kid)).status, 403);
      assert.equal((await putLink(spare.id, KID.memberId, KID)).status, 403);
      assert.equal(await code(await putLink(kidRow.id, null, KID)), 'parent_only');
      assert.equal((await get('/link', { ...as(KID), ...NAVIGATION })).status, 303);
      tailnet([{ ...PARENT, role: 'kid' }]);
      assert.equal((await get('/api/suite/links', { ...as(PARENT), ...OWN_PAGE })).status, 403, 'a directory kid linked to a parent row');
    });

    it('the routes check the directory\'s role themselves, behind the kid allowlist', async () => {
      const inner = express();
      inner.use((req, _res, next) => { req.suiteMember = { role: 'kid', memberId: KID.memberId }; next(); });
      inner.use(express.json());
      inner.use(createSuiteLinks(() => ({ tailnet: true, directory: () => [] })));
      const listener = inner.listen(0, '127.0.0.1');
      await new Promise((resolve) => listener.once('listening', resolve));
      try {
        const url = `http://127.0.0.1:${listener.address().port}`;
        assert.equal((await fetch(`${url}/link`)).status, 403);
        assert.equal((await fetch(`${url}/api/suite/links`)).status, 403);
        assert.equal((await fetch(`${url}/api/suite/links/${spare.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"suite_member_id":null}' })).status, 403);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    });

    it('none of it exists in local mode', async () => {
      assert.equal((await get('/link', NAVIGATION)).status, 404);
      assert.equal((await get('/api/suite/links', OWN_PAGE)).status, 404);
      assert.equal((await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ suite_member_id: PARENT.memberId }))).status, 404);
    });

    it('linking is refused from anywhere but the app\'s own page', async () => {
      tailnet();
      const body = JSON.stringify({ suite_member_id: NEW_PARENT.memberId });
      const sibling = await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://smith-home.example-tailnet.ts.net', 'content-type': 'application/json' }, body);
      assert.equal(sibling.status, 403);
      const form = await send('PUT', `/api/suite/links/${spare.id}`, { ...as(PARENT), ...OWN_PAGE, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body);
      assert.equal(form.status, 403);
    });
  });

  it('a linked parent gets everything a parent does, with no passphrase', async () => {
    tailnet();
    const parent = { ...as(PARENT), ...OWN_PAGE };
    const me = await (await get('/api/auth/me', parent)).json();
    assert.equal(me.id, parentRow.id);
    assert.equal(me.role, 'parent');
    assert.equal(me.tailnet, true, 'so pages drop sign-out and passphrases');
    for (const path of ['/api/accounts', '/api/items', '/api/auth/members']) assert.equal((await get(path, parent)).status, 200, path);
    const categories = await (await get('/api/categories', parent)).json();
    assert.ok(categories.length > 0);
    for (const category of categories) assert.ok('budget_amount' in category && 'transaction_count' in category, 'a parent keeps the full list');
    assert.equal((await get('/accounts.html', { ...as(PARENT), ...NAVIGATION })).status, 200);
    const login = await get('/login.html', { ...as(PARENT), ...NAVIGATION });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/pulse/');
    assert.equal((await bootstrapState()).bootstrap.needs_auth, false);
    assert.ok((await (await get('/api/bootstrap', parent)).json()).counts, 'a linked parent still sees the counts');
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
    // Every spelling Express routes to them is refused the same way.
    for (const path of ['/API/auth/login', '/api/AUTH/LOGIN', '/api/auth/login/', '/API/Auth/Login/']) {
      const answer = await send('POST', path, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ member_id: parentRow.id, passphrase: 'x' }));
      assert.equal(answer.status, 409, path);
      assert.equal((await answer.json()).code, 'tailnet_mode', path);
    }
    for (const path of ['/API/auth/passphrase', '/api/auth/passphrase/', '/Api/Auth/Passphrase/']) {
      const answer = await send('PUT', path, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ member_id: parentRow.id, passphrase: 'a-new-passphrase' }));
      assert.equal(answer.status, 409, path);
    }
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
    // However the path is spelled: Express routes all of these to the same handlers.
    for (const member of [PARENT, KID]) {
      for (const path of ['/API/magic/digest', '/Api/kids/report-card', '/API/accounts/', '/api/accounts/']) {
        const answer = await get(path, { ...as(member), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
        assert.equal(answer.status, 403, path);
        assert.equal((await answer.json()).code, 'not_a_page', path);
      }
    }
    const download = await get('/api/transaction-attachments/999999999/download', { ...as(PARENT), ...NAVIGATION });
    assert.equal(download.status, 404, 'reaches its route, which finds nothing');
  });

  it('another spelling of a path gets a kid or a stranger nothing, and is refused as an API path', async () => {
    tailnet();
    const kid = { ...as(KID), ...OWN_PAGE };
    for (const path of ['/API/items', '/Api/accounts', '/api/items/', '/API/categories', '/API/auth/me', '/api/auth/me/']) {
      const answer = await get(path, kid);
      assert.equal(answer.status, 403, path);
      assert.equal((await answer.json()).code, 'parent_only', path);
    }
    const stranger = await get('/API/accounts', OWN_PAGE);
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).code, 'not_member');
    // A spelling the unlinked parent's list doesn't know stays closed too.
    assert.equal((await get('/API/bootstrap', { ...as(NEW_PARENT), ...OWN_PAGE })).status, 403);
    const login = await get('/LOGIN.HTML', { ...as(PARENT), ...NAVIGATION });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/pulse/');
  });

  describe('passkeys', () => {
    const stepUp = async (answer, policy, label) => {
      assert.equal(answer.status, 401, label);
      assert.equal(answer.headers.get('cache-control'), 'no-store', label);
      assert.deepEqual(await answer.json(), { error: 'step_up_required', policy, level: policy === 'open-documents' ? 'session' : 'recent', kind: 'any' }, label);
    };
    const NAV = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

    it('a parent opens Family Pulse with a passkey check: a page asks for one, the API answers with the step-up', async () => {
      tailnet();
      for (const cookie of [null, 'sv_assurance=x', passkeyCookie(PARENT, { name: 'sv_assurance' }), passkeyCookie(PARENT, { name: '__HOST-sv_assurance' })]) {
        const page = await get('/accounts.html', { ...as(PARENT, cookie), ...NAV });
        assert.equal(page.status, 401, String(cookie));
        assert.equal(page.headers.get('cache-control'), 'no-store');
        const html = await page.text();
        assert.match(html, /<script src="\/pulse\/passkey\.js"><\/script>/, 'the check runs from the app\'s own address');
        assert.match(html, /data-step-up="\{&quot;error&quot;:&quot;step_up_required&quot;,&quot;policy&quot;:&quot;open-documents&quot;/);
        assert.doesNotMatch(html, /Suite Parent|budget|balance/i, 'and shows no data');
        await stepUp(await get('/api/accounts', { ...as(PARENT, cookie), ...OWN_PAGE }), 'open-documents', String(cookie));
      }
      // Every page, the kid view and the link page included, and a HEAD as much as a GET.
      for (const path of ['/', '/settings.html', '/kids/anyone', '/link', '/Accounts.html']) {
        assert.equal((await get(path, { ...as(PARENT, null), ...NAV })).status, 401, path);
        assert.equal((await send('HEAD', path, { ...as(PARENT, null), ...NAV })).status, 401, `HEAD ${path}`);
      }
      // A parent nobody has linked yet needs one too, before the link page shows them the household.
      assert.equal((await get('/link', { ...as(NEW_PARENT, null), ...NAV })).status, 401);
      await stepUp(await get('/api/suite/links', { ...as(NEW_PARENT, null), ...OWN_PAGE }), 'open-documents', 'unlinked parent');
      await stepUp(await get('/api/bootstrap', { ...as(NEW_PARENT, null), ...OWN_PAGE }), 'open-documents', 'unlinked parent setup');
      await stepUp(await send('POST', '/api/sync', { ...as(PARENT, null), ...JSON_WRITE }, '{}'), 'open-documents', 'a write');
      assert.equal((await get('/accounts.html', { ...as(PARENT), ...NAV })).status, 200, 'and with one, it opens');
    });

    it('a check counts for 30 days, for this member, on this hostname, until Home Base changes their access', async () => {
      tailnet();
      const day = 86400;
      assert.equal((await get('/api/accounts', { ...as(PARENT, passkeyCookie(PARENT, { age: 29 * day })), ...OWN_PAGE })).status, 200);
      const refusals = {
        'older than 30 days': passkeyCookie(PARENT, { age: 30 * day + 60 }),
        'another member\'s': passkeyCookie(NEW_PARENT),
        'another hostname\'s': passkeyCookie(PARENT, { aud: 'smith-home.example-tailnet.ts.net' }),
        'another household\'s': passkeyCookie(PARENT, { household: 'elsewhere' }),
        'from before Home Base changed their access': passkeyCookie(PARENT, { epoch: 0 }),
        'from before Home Base revoked everything': passkeyCookie(PARENT, { global_epoch: 0 }),
        'two of them': `${passkeyCookie(PARENT)}; ${passkeyCookie(PARENT)}`,
        'not signed by Home Base': passkeyCookie(PARENT).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      };
      for (const [label, cookie] of Object.entries(refusals)) await stepUp(await get('/api/accounts', { ...as(PARENT, cookie), ...OWN_PAGE }), 'open-documents', label);
    });

    it('kids never meet a passkey check (D7)', async () => {
      tailnet();
      const kid = { ...as(KID, null), ...OWN_PAGE };
      assert.equal((await get('/api/auth/me', kid)).status, 200);
      assert.equal((await get('/api/kids/dashboard', kid)).status, 200);
      assert.equal((await get('/kids.html', { ...as(KID, null), ...NAV })).status, 200);
    });

    it('linking banks, removing them, sharing accounts, alert destinations and member links need a check in the last five minutes', async () => {
      tailnet();
      const older = passkeyCookie(PARENT, { age: 6 * 60 });
      // As the pages send them: a DELETE has no body.
    const write = (method, path) => send(method, path, { ...as(PARENT, older), ...JSON_WRITE }, method === 'DELETE' ? undefined : '{}');
      assert.equal((await get('/api/accounts', { ...as(PARENT, older), ...OWN_PAGE })).status, 200, 'it still opens Family Pulse');
      const recent = [
        ['POST', '/api/link/create-token', 'link-account'],
        ['POST', '/api/link/update-token', 'link-account'],
        ['POST', '/api/link/create-liability-upgrade-token', 'link-account'],
        ['POST', '/api/link/create-account-selection-token', 'link-account'],
        ['POST', '/API/Link/Create-Token/', 'link-account'],
        ['DELETE', '/api/items/999999', 'link-account'],
        ['DELETE', '/api/items/999999/purge', 'link-account'],
        ['DELETE', '/API/items/0999999/', 'link-account'],
        ['PUT', '/api/auth/account-members', 'export-data'],
        ['PUT', '/Api/Auth/Account-Members/', 'export-data'],
        ['PUT', '/api/items/999999/owner', 'export-data'],
        ['PUT', '/Api/Items/999999/Owner/', 'export-data'],
        ['PUT', `/api/notification-channels/${parentRow.id}/brrr`, 'export-data'],
        ['DELETE', `/api/notification-channels/${parentRow.id}/brrr`, 'export-data'],
        ['PUT', `/api/notification-subscriptions/${parentRow.id}`, 'export-data'],
        ['PUT', '/api/notification-config/notification_base_url', 'export-data'],
        ['PUT', '/API/notification-config/large_expense_threshold/', 'export-data'],
        ['PUT', `/api/suite/links/${kidRow.id}`, 'change-role'],
        ['PUT', `/API/Suite/Links/${kidRow.id}/`, 'change-role'],
      ];
      for (const [method, path, policy] of recent) await stepUp(await write(method, path), policy, `${method} ${path}`);
      // Finishing a link a recent check started needs only the session: a bank's own sign-in can outlast five minutes.
      for (const path of ['/api/link/exchange', '/api/link/complete-account-selection', '/api/link/complete-liability-upgrade']) {
        assert.notEqual((await write('POST', path)).status, 401, path);
      }
      assert.notEqual((await write('POST', '/api/items/999999/sync')).status, 401, 'syncing changes nothing about access');
      assert.notEqual((await write('POST', `/api/notification-channels/${parentRow.id}/brrr/test`)).status, 401, 'a test alert goes where alerts already go');
      // With a check just now, the change goes through to its route.
      assert.equal((await send('PUT', `/api/suite/links/${kidRow.id}`, { ...as(PARENT), ...JSON_WRITE }, JSON.stringify({ suite_member_id: KID.memberId }))).status, 200);
    });

    it('local mode asks for no passkey', async () => {
      assert.equal((await get('/api/accounts', OWN_PAGE)).status, 200);
      assert.equal((await get('/accounts.html', NAV)).status, 200);
    });
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
