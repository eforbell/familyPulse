'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMerchantName, buildMerchantFingerprint } = require('../lib/merchant-normalizer');

describe('merchant-normalizer', () => {
  it('normalizes common merchant noise patterns', () => {
    assert.equal(normalizeMerchantName('NETFLIX.COM/123456789'), 'netflix com');
    assert.equal(normalizeMerchantName('Spotify USA LLC 03/15'), 'spotify usa');
    assert.equal(normalizeMerchantName('CITY OF AUSTIN 2025'), 'city of austin');
  });

  it('falls back to transaction name when merchant name is missing', () => {
    assert.equal(normalizeMerchantName('', 'Payroll ACME INC'), 'payroll acme');
  });

  it('returns unknown when both merchant and fallback are blank', () => {
    assert.equal(normalizeMerchantName(null, ''), 'unknown');
  });

  it('builds a deterministic fingerprint from a transaction object', () => {
    const tx = { merchant_name: 'NETFLIX.COM/123456', name: 'Netflix 123456' };
    assert.equal(buildMerchantFingerprint(tx), 'netflix com');
    assert.equal(buildMerchantFingerprint(tx), 'netflix com');
  });
});
