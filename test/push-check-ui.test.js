'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8');
function fn(name) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('save feedback survives list replacement, and rechecking renders failure/unsupported feedback', async () => {
  const nodes = new Map();
  const make = (id, extra = {}) => nodes.set(id, { textContent: '', value: '', classList: { remove() {} }, ...extra });
  make('notify-secret-1', { value: 'new_secret_value_1234' });
  make('notify-enabled-1', { checked: true });
  make('notifyLabel-1');
  make('notify-status-1');
  let verification = { status: 'verified', message: 'Gateway ready; no notification sent.' };
  const requests = [];
  const context = {
    pushRegistrationRequests: new Map(),
    document: { getElementById: id => nodes.get(id) },
    api: async (url, opts) => { requests.push({ url, opts }); return opts.method === 'PUT' ? { verification } : verification; },
    settingsFetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => opts.method === 'PUT' ? { verification } : verification }; },
    loadNotificationChannels: async () => make('notify-status-1'),
    setStatus: (el, text) => { el.textContent = text; },
    alert: msg => assert.fail(msg),
  };
  vm.createContext(context);
  vm.runInContext(fn('saveNotificationChannel') + '\n' + fn('checkNotificationChannel'), context);
  await context.saveNotificationChannel(1);
  assert.match(nodes.get('notify-status-1').textContent, /Saved.*Gateway ready/i);
  assert.equal(nodes.get('notify-secret-1').value, '');
  for (const status of ['failed', 'unsupported']) {
    verification = { status, message: `${status}: not verified` };
    await context.checkNotificationChannel(1);
    assert.equal(nodes.get('notify-status-1').textContent, verification.message);
  }
  assert.ok(requests.slice(1).every(r => r.opts.method === 'POST' && r.url.endsWith('/brrr/check')));
  assert.ok(!requests.some(r => r.url.endsWith('/test')));
  assert.match(source, /Verify saved secret \(no push\)/);
});


test('late save/check responses cannot verify a secret that was cleared meanwhile', async () => {
  for (const pending of ['save', 'check']) {
    const nodes = new Map();
    const make = (id, extra = {}) => nodes.set(id, { textContent: '', value: '', classList: { remove() {} }, ...extra });
    for (const id of ['notifySecret-1', 'notify-secret-1']) make(id, { value: 'fixture_secret_1234' });
    for (const id of ['notifyEnabled-1', 'notify-enabled-1']) make(id, { checked: true });
    make('notifyLabel-1'); make('notify-status-1');
    let finish;
    const request = async (_url, opts) => {
      if (opts.method === (pending === 'save' ? 'PUT' : 'POST')) return new Promise(resolve => { finish = resolve; });
      return {};
    };
    const context = {
      pushRegistrationRequests: new Map(),
      document: { getElementById: id => nodes.get(id) }, confirm: () => true, window: { confirm: () => true },
      api: request, settingsFetch: async (...args) => ({ ok: true, json: async () => request(...args) }),
      loadNotificationChannels: async () => make('notify-status-1'),
      setStatus: (el, text) => { el.textContent = text; }, alert: msg => assert.fail(msg),
    };
    vm.createContext(context);
    vm.runInContext(['saveNotificationChannel', 'checkNotificationChannel', 'clearNotificationChannel'].map(fn).join('\n'), context);
    const old = pending === 'save' ? context.saveNotificationChannel(1) : context.checkNotificationChannel(1);
    // settingsFetch resolves before its delayed json(), whereas api delays directly.
    await new Promise(resolve => setImmediate(resolve));
    await context.clearNotificationChannel(1);
    const verification = { status: 'verified', message: 'OLD SECRET VERIFIED' };
    finish(pending === 'save' ? { verification } : verification);
    await old;
    assert.ok(!nodes.get('notify-status-1').textContent.includes('OLD SECRET VERIFIED'), pending);
  }
});
