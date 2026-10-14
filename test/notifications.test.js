'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePayload, sendBrrrNotification, withIconUrl } = require('../lib/notifications');

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
    assert.deepEqual(withIconUrl({ title: 'Test' }, 'https://'), { title: 'Test' });
  });

  it('keeps an explicit per-payload icon_url', () => {
    const payload = withIconUrl({ icon_url: 'https://a.test/x.png' }, 'https://b.test/y.png');
    assert.equal(payload.icon_url, 'https://a.test/x.png');
  });

  it('sends BRRR_ICON_URL as icon_url in the brrr request', async () => {
    const originalFetch = global.fetch;
    const originalIcon = process.env.BRRR_ICON_URL;
    let sentBody;
    global.fetch = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200 };
    };
    process.env.BRRR_ICON_URL = 'https://cdn.example.test/fp.png';
    try {
      await sendBrrrNotification('secret-value-1234', { title: 'Test', body: 'Hi' });
    } finally {
      global.fetch = originalFetch;
      if (originalIcon === undefined) delete process.env.BRRR_ICON_URL;
      else process.env.BRRR_ICON_URL = originalIcon;
    }
    assert.deepEqual(sentBody, {
      title: 'Test',
      message: 'Hi',
      icon_url: 'https://cdn.example.test/fp.png'
    });
  });
});
