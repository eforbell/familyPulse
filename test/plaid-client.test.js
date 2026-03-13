'use strict';

require('dotenv').config();
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const plaid = require('../lib/plaid-client');

describe('plaid-client — liabilities fallback', () => {
  it('returns null when liability consent has not been granted for the item', async () => {
    const restore = mock.method(plaid.client, 'liabilitiesGet', async () => {
      const err = new Error('missing liability consent');
      err.response = {
        data: {
          error_code: 'ADDITIONAL_CONSENT_REQUIRED',
          error_message: 'client does not have user consent to access the PRODUCT_LIABILITIES product'
        }
      };
      throw err;
    });

    try {
      const result = await plaid.getLiabilities('test-access-token');
      assert.equal(result, null);
    } finally {
      restore.mock.restore();
    }
  });
});
