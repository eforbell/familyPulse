'use strict';

const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const { normalizeBrrrTarget, pushBaseUrl, sendBrrrNotification } = require('../lib/notifications');

const ORIGINAL = process.env.PUSH_BASE_URL;
const realFetch = global.fetch;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUSH_BASE_URL;
  else process.env.PUSH_BASE_URL = ORIGINAL;
  global.fetch = realFetch;
});

test('unset, targets are exactly what they were: brrr, with saved brrr URLs untouched', () => {
  delete process.env.PUSH_BASE_URL;
  assert.equal(normalizeBrrrTarget('abc123secret'), 'https://api.brrr.now/v1/abc123secret');
  assert.equal(normalizeBrrrTarget('https://api.brrr.now/v1/abc123secret'), 'https://api.brrr.now/v1/abc123secret');
});

test('a configured service is used for bare secrets, including a path prefix', () => {
  process.env.PUSH_BASE_URL = 'https://gateway.example.test/push/';
  assert.equal(pushBaseUrl(), 'https://gateway.example.test/push');
  assert.equal(normalizeBrrrTarget('hp_secretvalue'), 'https://gateway.example.test/push/v1/hp_secretvalue');
  assert.equal(normalizeBrrrTarget('https://gateway.example.test/push/v1/hp_secretvalue'), 'https://gateway.example.test/push/v1/hp_secretvalue');
});

test('a saved URL for another service is refused, and the error does not carry the secret', () => {
  process.env.PUSH_BASE_URL = 'http://127.0.0.1:3014';
  for (const target of ['https://api.brrr.now/v1/oldsecret123', 'http://127.0.0.1:3014.evil.test/v1/oldsecret123',
    'http://127.0.0.1:3014/other/oldsecret123', 'http://127.0.0.1:3014/v1/../oldsecret123']) {
    assert.throws(() => normalizeBrrrTarget(target), (err) => /different push service/.test(err.message) && !err.message.includes('oldsecret123'), target);
  }
  delete process.env.PUSH_BASE_URL;
  assert.throws(() => normalizeBrrrTarget('https://evil.example.test/v1/oldsecret123'), /different push service/);
});

test('a malformed PUSH_BASE_URL fails the send and never falls back to brrr', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  for (const bad of ['not a url', 'ftp://gateway.example.test', 'https://user:pass@gateway.example.test', 'https://gateway.example.test/?x=1']) {
    process.env.PUSH_BASE_URL = bad;
    await assert.rejects(sendBrrrNotification('hp_secretvalue', { title: 't', message: 'm' }), /PUSH_BASE_URL/, bad);
  }
  assert.equal(called, false);
});

test('sending posts to the configured service', async () => {
  process.env.PUSH_BASE_URL = 'http://127.0.0.1:3014';
  let seen;
  global.fetch = async (url) => { seen = url; return { ok: true, status: 200 }; };
  await sendBrrrNotification('hp_secretvalue', { title: 't', message: 'm' });
  assert.equal(seen, 'http://127.0.0.1:3014/v1/hp_secretvalue');
});
