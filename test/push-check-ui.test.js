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
