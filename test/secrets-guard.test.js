'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before loading module
process.env.PLAID_SECRET = 'test_secret_key_12345678';
process.env.PLAID_CLIENT_ID = 'test_client_id_12345678';
process.env.OPENAI_API_KEY = 'sk-test1234567890abcdefghijklmno';

const { sanitizeString, sanitizeForLog, sanitizeForLLM, assertNoSecrets } = require('../lib/secrets-guard');

describe('secrets-guard', () => {
  describe('sanitizeString', () => {
    it('redacts Plaid sandbox access tokens', () => {
      const input = 'Token is access-sandbox-abc123def-456-789';
      const result = sanitizeString(input);
      assert.ok(!result.includes('access-sandbox-'));
      assert.ok(result.includes('[REDACTED]'));
    });

    it('redacts Plaid production access tokens', () => {
      const input = 'access-production-aabbccdd-1122-3344-5566-778899aabbcc';
      const result = sanitizeString(input);
      assert.ok(!result.includes('access-production-'));
      assert.ok(result.includes('[REDACTED]'));
    });

    it('redacts OpenAI API keys', () => {
      const input = 'Key: sk-abcdefghijklmnopqrstuvwxyz';
      const result = sanitizeString(input);
      assert.ok(!result.includes('sk-abcdefghijklmnopqrst'));
      assert.ok(result.includes('[REDACTED]'));
    });

    it('redacts env var values', () => {
      const input = `Secret: ${process.env.PLAID_SECRET}`;
      const result = sanitizeString(input);
      assert.ok(!result.includes('test_secret_key_12345678'));
      assert.ok(result.includes('[REDACTED]'));
    });

    it('returns non-string values unchanged', () => {
      assert.equal(sanitizeString(42), 42);
      assert.equal(sanitizeString(null), null);
      assert.equal(sanitizeString(undefined), undefined);
    });

    it('handles strings with no secrets', () => {
      assert.equal(sanitizeString('hello world'), 'hello world');
    });
  });

  describe('sanitizeForLog', () => {
    it('redacts access_token keys in objects', () => {
      const obj = { access_token: 'access-sandbox-abc123', name: 'Test' };
      const result = sanitizeForLog(obj);
      assert.equal(result.access_token, '[REDACTED]');
      assert.equal(result.name, 'Test');
    });

    it('redacts secret keys in objects', () => {
      const obj = { secret: 'my-secret', api_key: 'key-123', data: 'safe' };
      const result = sanitizeForLog(obj);
      assert.equal(result.secret, '[REDACTED]');
      assert.equal(result.api_key, '[REDACTED]');
      assert.equal(result.data, 'safe');
    });

    it('deep-sanitizes nested objects', () => {
      const obj = { outer: { access_token: 'access-sandbox-abc123' } };
      const result = sanitizeForLog(obj);
      assert.equal(result.outer.access_token, '[REDACTED]');
    });

    it('sanitizes arrays', () => {
      const arr = [{ access_token: 'token1' }, { name: 'safe' }];
      const result = sanitizeForLog(arr);
      assert.equal(result[0].access_token, '[REDACTED]');
      assert.equal(result[1].name, 'safe');
    });

    it('sanitizes token patterns in string values', () => {
      const obj = { message: 'Error with access-sandbox-abc123def-456-789' };
      const result = sanitizeForLog(obj);
      assert.ok(!result.message.includes('access-sandbox-'));
    });
  });

  describe('sanitizeForLLM', () => {
    it('strips secrets same as sanitizeForLog', () => {
      const obj = { access_token: 'token', data: 'safe' };
      const result = sanitizeForLLM(obj);
      assert.equal(result.access_token, '[REDACTED]');
      assert.equal(result.data, 'safe');
    });
  });

  describe('assertNoSecrets', () => {
    it('throws on access_token column', () => {
      const rows = [{ id: 1, access_token: 'some-token', name: 'Test' }];
      assert.throws(() => assertNoSecrets(rows), /SECURITY.*access_token/);
    });

    it('does not throw on safe columns', () => {
      const rows = [{ id: 1, name: 'Test', amount: 42 }];
      assert.doesNotThrow(() => assertNoSecrets(rows));
    });

    it('handles empty arrays', () => {
      assert.doesNotThrow(() => assertNoSecrets([]));
    });

    it('handles null/undefined', () => {
      assert.doesNotThrow(() => assertNoSecrets(null));
      assert.doesNotThrow(() => assertNoSecrets(undefined));
    });
  });
});
