'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hashPassphrase, verifyPassphrase, parseCookie } = require('../lib/auth');

describe('passphrase hashing', () => {
  it('produces a salt:hash string', () => {
    const hashed = hashPassphrase('test-phrase');
    assert.ok(hashed.includes(':'), 'should contain salt:hash separator');
    const [salt, hash] = hashed.split(':');
    assert.equal(salt.length, 32, 'salt should be 16 bytes hex = 32 chars');
    assert.equal(hash.length, 128, 'hash should be 64 bytes hex = 128 chars');
  });

  it('verifies a correct passphrase', () => {
    const hashed = hashPassphrase('my-secret');
    assert.ok(verifyPassphrase('my-secret', hashed));
  });

  it('rejects an incorrect passphrase', () => {
    const hashed = hashPassphrase('correct-phrase');
    assert.ok(!verifyPassphrase('wrong-phrase', hashed));
  });

  it('rejects null/empty stored hash', () => {
    assert.ok(!verifyPassphrase('anything', null));
    assert.ok(!verifyPassphrase('anything', ''));
  });

  it('produces unique hashes for same passphrase (random salt)', () => {
    const h1 = hashPassphrase('same-pass');
    const h2 = hashPassphrase('same-pass');
    assert.notEqual(h1, h2, 'different salts should produce different hashes');
    // Both should verify
    assert.ok(verifyPassphrase('same-pass', h1));
    assert.ok(verifyPassphrase('same-pass', h2));
  });
});

describe('parseCookie', () => {
  it('extracts a named cookie', () => {
    const header = 'fp_session=abc123; other=xyz';
    assert.equal(parseCookie(header, 'fp_session'), 'abc123');
  });

  it('returns null for missing cookie', () => {
    assert.equal(parseCookie('other=xyz', 'fp_session'), null);
  });

  it('handles null header', () => {
    assert.equal(parseCookie(null, 'fp_session'), null);
  });

  it('handles cookie with spaces', () => {
    const header = 'a=1; fp_session=token123; b=2';
    assert.equal(parseCookie(header, 'fp_session'), 'token123');
  });
});

describe('requireAuth middleware', () => {
  const { requireAuth, requireParent } = require('../lib/auth');

  it('returns 401 when req.member is missing', () => {
    let statusCode, body;
    const req = {};
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; }
    };
    requireAuth(req, res, () => {});
    assert.equal(statusCode, 401);
    assert.ok(body.error.includes('Authentication'));
  });

  it('calls next when req.member is set', () => {
    let called = false;
    const req = { member: { id: 1, name: 'Eric', role: 'parent' } };
    requireAuth(req, {}, () => { called = true; });
    assert.ok(called);
  });

  it('requireParent returns 403 for kid role', () => {
    let statusCode, body;
    const req = { member: { id: 3, name: 'Jordan', role: 'kid' } };
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; }
    };
    requireParent(req, res, () => {});
    assert.equal(statusCode, 403);
    assert.ok(body.error.includes('Parent'));
  });

  it('requireParent passes for parent role', () => {
    let called = false;
    const req = { member: { id: 1, name: 'Eric', role: 'parent' } };
    requireParent(req, {}, () => { called = true; });
    assert.ok(called);
  });
});
