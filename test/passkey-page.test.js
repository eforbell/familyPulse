'use strict';
// public/passkey.js under Node: a tab's sessionStorage carries over between page loads, and Home Base's helper is a
// stand-in that records each check. A check that went through reloads the page; only that same page coming straight
// back from the reload, with the same check, waits for a tap. Most of Family Pulse's pages don't load passkey.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../public/passkey.js'), 'utf8');
const OPEN = { error: 'step_up_required', policy: 'open-documents', level: 'session', kind: 'any' };
const PAGE = 'https://smith-pulse.example-tailnet.ts.net/pulse/';

function tab() {
  const store = new Map();
  return {
    checks: [],
    reloads: 0,
    seenReloads: 0,
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
  };
}

// Loads one page in the tab: the passkey page when `stepUp` is given, an ordinary page that loads the script otherwise.
// `how` is the navigation's type; a page the check reloaded comes back as 'reload'.
async function load(t, { href = PAGE, stepUp = null, answers = [], how } = {}) {
  const type = how || (t.reloads > t.seenReloads ? 'reload' : 'navigate');
  t.seenReloads = t.reloads;
  const el = () => ({ textContent: '', hidden: false, addEventListener() {} });
  const nodes = { 'passkey-status': el(), 'passkey-retry': el() };
  if (stepUp) nodes['passkey-check'] = { dataset: { stepUp: JSON.stringify(stepUp) } };
  const window = {
    location: { href, reload: () => { t.reloads += 1; } },
    SovereignStepUp: { satisfy: async (asked) => { t.checks.push(asked.policy); return null; } },
  };
  const context = {
    window,
    sessionStorage: t.sessionStorage,
    document: { getElementById: (id) => nodes[id] || null, createElement() {}, head: { append() {} } },
    fetch: async () => {
      const body = answers.shift();
      return { status: body ? 401 : 200, clone: () => ({ json: async () => body }) };
    },
    Date,
    performance: { getEntriesByType: (kind) => (kind === 'navigation' ? [{ type }] : []) },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { status: nodes['passkey-status'], retry: nodes['passkey-retry'], window };
}

test('a passkey page that comes straight back after its own check waits for a tap', async () => {
  const t = tab();
  await load(t, { stepUp: OPEN });
  assert.deepEqual([t.checks, t.reloads], [['open-documents'], 1]);
  const again = await load(t, { stepUp: OPEN });
  assert.match(again.status.textContent, /went through, but Family Pulse couldn't confirm it yet/);
  assert.equal(again.retry.hidden, false);
  assert.equal(t.checks.length, 1, 'no second check without a tap');
});

test('a check that brought the page up is forgotten once that page has loaded', async () => {
  // The check went through and the reload opened Settings, which loads passkey.js. A passkey page a few seconds later
  // (Home Base rotated its key, say) is a new refusal: it runs its own check.
  const t = tab();
  await load(t, { stepUp: OPEN });
  await load(t);
  const later = await load(t, { stepUp: OPEN, how: 'reload' });
  assert.equal(later.status.textContent, '');
  assert.deepEqual(t.checks, ['open-documents', 'open-documents']);
});

test('a passkey page reached by a link runs its check, even after a page that never loaded passkey.js', async () => {
  // The reload opened the dashboard, which doesn't load passkey.js, so the mark is still there.
  const t = tab();
  await load(t, { stepUp: OPEN });
  t.seenReloads = t.reloads;
  for (const how of ['navigate', 'back_forward']) {
    const later = await load(t, { stepUp: OPEN, how });
    assert.equal(later.status.textContent, '', how);
  }
  assert.equal(t.checks.length, 3);
});

test('another page, or another check, runs its own', async () => {
  for (const next of [{ href: `${PAGE}settings.html`, stepUp: OPEN }, { stepUp: { ...OPEN, policy: 'link-account', level: 'recent' } }]) {
    const t = tab();
    await load(t, { stepUp: OPEN });
    const page = await load(t, next);
    assert.equal(page.status.textContent, '');
    assert.equal(t.checks.length, 2);
  }
});

test('a mark left by the previous version of this script asks nothing extra of the member', async () => {
  const t = tab();
  t.sessionStorage.setItem('pulse-passkey-reloaded', String(Date.now()));
  await load(t, { stepUp: OPEN });
  assert.deepEqual(t.checks, ['open-documents']);
});

test('only the library\'s whole step-up answer starts a check', async () => {
  const t = tab();
  const page = await load(t, { answers: [{ error: 'step_up_required' }] });
  const res = await page.window.PulsePasskey.fetch('api/settings');
  assert.equal(res.status, 401);
  assert.deepEqual(t.checks, []);
  const whole = await load(t, { answers: [{ ...OPEN, policy: 'export-data', level: 'recent' }] });
  assert.equal((await whole.window.PulsePasskey.fetch('api/settings', { method: 'PUT' })).status, 200);
  assert.deepEqual(t.checks, ['export-data']);
});
