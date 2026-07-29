'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { client, PLAID_REQUEST_TIMEOUT_MS } = require('../lib/plaid-client');

test('Plaid client bounds outbound request time below proxy timeout', () => {
  assert.equal(PLAID_REQUEST_TIMEOUT_MS, 20_000);
  assert.equal(client.configuration.baseOptions.timeout, PLAID_REQUEST_TIMEOUT_MS);
});
