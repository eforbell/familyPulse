'use strict';

// In tailnet mode every write must say it is JSON, even with no body, and only the upload routes may send a form
// (wire contract, section 4). Pages write through their own api() helpers, so this checks the helpers and any direct
// fetch. A page that forgets works in local mode and fails only on a tailnet household.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const scripts = fs.readdirSync(PUBLIC).filter((name) => name.endsWith('.js'));
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

// Sent as files, on routes that take them. Sign-out isn't offered in tailnet mode.
const NOT_JSON = [/api\/import\/upload/, /api\/import\/commit/, /api\/auth\/logout/];

describe('page writes', () => {
  it('every api() helper sends JSON unless the caller says otherwise', () => {
    let helpers = 0;
    for (const name of scripts) {
      for (const [, body] of read(name).matchAll(/async function api\(url, opts\) \{\n([^\n]*)\n/g)) {
        helpers += 1;
        assert.match(body, /'Content-Type': 'application\/json', \.\.\.opts\?\.headers/, name);
      }
    }
    assert.ok(helpers >= 9, `found ${helpers} helpers`);
  });

  it('a direct fetch that writes says it is JSON', () => {
    let writes = 0;
    for (const name of scripts) {
      for (const [call] of read(name).matchAll(/fetch\([^\n]*method: '(?:POST|PUT|PATCH|DELETE)'[^\n]*/g)) {
        if (NOT_JSON.some((route) => route.test(call))) continue;
        writes += 1;
        assert.match(call, /'Content-Type': 'application\/json'/, `${name}: ${call}`);
      }
    }
    assert.ok(writes >= 2, `found ${writes} direct writes`);
  });
});
