'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  issueBootstrapToken,
  hasValidBootstrapToken,
  consumeBootstrapToken,
} = require('../lib/bootstrap-token');

describe('bootstrap token helper', () => {
  it('issues valid tokens and consumes them once', () => {
    const token = issueBootstrapToken();
    assert.equal(typeof token, 'string');
    assert.equal(hasValidBootstrapToken(token), true);
    assert.equal(consumeBootstrapToken(token), true);
    assert.equal(hasValidBootstrapToken(token), false);
  });
});
