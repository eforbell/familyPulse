'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePayload } = require('../lib/notifications');

describe('notifications helper', () => {
  it('maps legacy body and interruption-level fields to brrr JSON fields', () => {
    const payload = normalizePayload({
      title: 'Test',
      body: 'Hello world',
      'interruption-level': 'time-sensitive'
    });

    assert.deepEqual(payload, {
      title: 'Test',
      message: 'Hello world',
      interruption_level: 'time-sensitive'
    });
  });

  it('preserves an explicit message field', () => {
    const payload = normalizePayload({
      title: 'Test',
      body: 'Old body',
      message: 'Real message'
    });

    assert.equal(payload.message, 'Real message');
    assert.equal('body' in payload, false);
  });
});
