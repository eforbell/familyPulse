'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateStartupConfig } = require('../lib/startup-validation');

describe('startup config validation', () => {
  it('accepts a valid sandbox config', () => {
    assert.doesNotThrow(() => validateStartupConfig({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox'
    }));
  });

  it('rejects missing PLAID_ENV', () => {
    assert.throws(() => validateStartupConfig({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret'
    }), /PLAID_ENV/);
  });

  it('rejects production config without redirect URI', () => {
    assert.throws(() => validateStartupConfig({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'production',
      APP_URL: 'https://home.example.ts.net/pulse'
    }), /PLAID_OAUTH_REDIRECT_URI/);
  });

  it('rejects production config without APP_URL', () => {
    assert.throws(() => validateStartupConfig({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'production',
      PLAID_OAUTH_REDIRECT_URI: 'https://plaid-callback.example.com/oauth/callback'
    }), /APP_URL/);
  });

  it('accepts a valid production config', () => {
    assert.doesNotThrow(() => validateStartupConfig({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'production',
      PLAID_OAUTH_REDIRECT_URI: 'https://plaid-callback.example.com/oauth/callback',
      APP_URL: 'https://home.example.ts.net/pulse'
    }));
  });
});

describe('server startup Plaid config handling', () => {
  it('reports missing Plaid config as setup state instead of throwing at startup boundary', () => {
    const { warnIfPlaidConfigMissing } = require('../server');
    const warnings = [];
    const status = warnIfPlaidConfigMissing({}, {
      warn(message, meta) {
        warnings.push({ message, meta });
      }
    });

    assert.equal(status.configured, false);
    assert.match(status.error, /PLAID_CLIENT_ID/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /incomplete Plaid configuration/);
  });
});
