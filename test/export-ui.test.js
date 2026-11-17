'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8');
const start = source.indexOf('async function downloadDataExport(');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);

function setup(response) {
  const button = { disabled: false }, status = { textContent: '' };
  const actions = [];
  const link = { click() { actions.push('click'); }, remove() { actions.push('remove'); } };
  const context = {
    document: {
      getElementById: id => id === 'export-csv-btn' ? button : status,
      createElement: () => link,
      body: { appendChild: () => actions.push('append') }
    },
    encodeURIComponent,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => actions.push(value) },
    setTimeout: (fn, delay) => { assert.equal(delay, 60_000); fn(); },
    fetch: async (url, options) => { actions.push(url); assert.equal(options.cache, 'no-store'); return response; }
  };
  vm.createContext(context);
  vm.runInContext(fn, context);
  return { context, button, status, actions, link };
}

test('Settings downloads an authenticated relative URL, uses server filename, and releases resources', async () => {
  const fixture = setup({ ok: true, blob: async () => ({}), headers: new Map([['Content-Disposition', 'attachment; filename="familypulse-export.csv"']]) });
  await fixture.context.downloadDataExport('csv');
  assert.equal(fixture.link.download, 'familypulse-export.csv');
  assert.equal(fixture.link.href, 'blob:test');
  assert.equal(fixture.button.disabled, false);
  assert.match(fixture.status.textContent, /downloaded/);
  assert.deepEqual(fixture.actions, ['api/export?format=csv', 'append', 'click', 'remove', 'blob:test']);
});

test('Settings shows server/network errors, restores the button, and permits retry', async () => {
  const fixture = setup({ ok: false, json: async () => ({ error: 'Parent access required' }) });
  await fixture.context.downloadDataExport('csv');
  assert.equal(fixture.status.textContent, 'Parent access required');
  assert.equal(fixture.button.disabled, false);
  fixture.context.fetch = async () => { throw new Error('Network unavailable'); };
  await fixture.context.downloadDataExport('csv');
  assert.equal(fixture.status.textContent, 'Network unavailable');
  assert.equal(fixture.button.disabled, false);
  assert.ok(!fixture.actions.includes('click'));
});

test('Settings ignores repeated clicks while preparing an export', async () => {
  const fixture = setup({});
  fixture.button.disabled = true;
  await fixture.context.downloadDataExport('csv');
  assert.deepEqual(fixture.actions, []);
});
