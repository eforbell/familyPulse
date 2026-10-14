'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePayload, withIconUrl } = require('../lib/notifications');

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

  it('adds icon_url from the configured icon URL', () => {
    const payload = withIconUrl({ title: 'Test' }, ' https://cdn.example.test/fp.png ');
    assert.equal(payload.icon_url, 'https://cdn.example.test/fp.png');
  });

  it('leaves payload alone when no valid icon URL is configured', () => {
    assert.deepEqual(withIconUrl({ title: 'Test' }, ''), { title: 'Test' });
    assert.deepEqual(withIconUrl({ title: 'Test' }, 'fp.png'), { title: 'Test' });
  });

  it('keeps an explicit per-payload icon_url', () => {
    const payload = withIconUrl({ icon_url: 'https://a.test/x.png' }, 'https://b.test/y.png');
    assert.equal(payload.icon_url, 'https://a.test/x.png');
  });
});
