'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const notifications = require('../lib/notifications');
const { app } = require('../server');

let server;
let baseUrl;
let sessionToken;
let ericId;
let valId;
let originalSendBrrrNotification;
let lastTestSend = null;

function req(path, opts = {}) {
  return fetch(`${baseUrl}/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${sessionToken}`,
      ...opts.headers
    }
  });
}

before(async () => {
  for (const migrationName of ['019-notification-foundation.sql', '020-notification-phase2-rules.sql']) {
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', migrationName),
      'utf8'
    );
    await pool.query(migrationSql);
  }

  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { rows } = await pool.query(
    "SELECT id, name FROM family_members WHERE role = 'parent' ORDER BY id"
  );
  ericId = rows.find(row => row.name === 'Eric')?.id || rows[0]?.id;
  valId = rows.find(row => row.name === 'Alex')?.id || rows[1]?.id || rows[0]?.id;

  sessionToken = crypto.randomUUID();
  await pool.query(
    'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)',
    [sessionToken, ericId, new Date(Date.now() + 24 * 60 * 60 * 1000)]
  );

  originalSendBrrrNotification = notifications.sendBrrrNotification;
  notifications.sendBrrrNotification = async (secretOrUrl, payload) => {
    lastTestSend = { secretOrUrl, payload };
    return { status: 200 };
  };
});

after(async () => {
  notifications.sendBrrrNotification = originalSendBrrrNotification;
  await pool.query('DELETE FROM notification_delivery_log');
  await pool.query('DELETE FROM notification_event_state');
  await pool.query('DELETE FROM member_notification_subscriptions');
  await pool.query('DELETE FROM member_notification_channels');
  await pool.query("DELETE FROM sessions WHERE token = $1", [sessionToken]);
  await pool.query(`
    UPDATE app_config
    SET value = CASE key
      WHEN 'notifications_enabled' THEN 'false'
      WHEN 'notification_base_url' THEN ''
      WHEN 'notification_default_interruption_level' THEN 'active'
      WHEN 'large_expense_threshold' THEN '1000'
      WHEN 'budget_overrun_threshold_pct' THEN '15'
      ELSE value
    END
    WHERE key IN ('notifications_enabled', 'notification_base_url', 'notification_default_interruption_level', 'large_expense_threshold', 'budget_overrun_threshold_pct')
  `);
  server.close();
  const { pool: dbPool } = require('../lib/db');
  await dbPool.end();
  await pool.end();
});

describe('notification settings API', () => {
  it('returns notification config', async () => {
    const res = await req('api/notification-config');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.notifications_enabled, 'string');
    assert.equal(typeof data.notification_base_url, 'string');
    assert.equal(typeof data.notification_default_interruption_level, 'string');
    assert.equal(typeof data.large_expense_threshold, 'string');
    assert.equal(typeof data.budget_overrun_threshold_pct, 'string');
  });

  it('updates notification config', async () => {
    const res = await req('api/notification-config/large_expense_threshold', {
      method: 'PUT',
      body: JSON.stringify({ value: 1500 })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.value, '1500');
  });

  it('lists parent notification channels with subscriptions', async () => {
    const res = await req('api/notification-channels');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.event_types));
    assert.ok(Array.isArray(data.members));
    assert.ok(data.members.every(member => member.member_role === 'parent'));
    assert.ok(typeof data.members[0].subscriptions.large_expense === 'boolean');
  });

  it('saves a brrr channel with masked readback', async () => {
    const res = await req(`api/notification-channels/${valId}/brrr`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, secret: 'https://api.brrr.now/v1/test-secret-123456' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.equal(data.has_secret, true);
    assert.ok(data.secret_mask.includes('3456'));
  });

  it('saves per-member subscriptions', async () => {
    const res = await req(`api/notification-subscriptions/${valId}`, {
      method: 'PUT',
      body: JSON.stringify({
        subscriptions: {
          large_expense: true,
          sync_issue: true,
          month_in_review: false,
          budget_overrun: false
        }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.subscriptions.large_expense, true);
    assert.equal(data.subscriptions.sync_issue, true);
  });

  it('sends a test notification through the brrr helper', async () => {
    await req('api/notification-config/notification_base_url', {
      method: 'PUT',
      body: JSON.stringify({ value: 'https://pulse.example.test' })
    });

    const res = await req(`api/notification-channels/${valId}/brrr/test`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    assert.ok(lastTestSend);
    assert.equal(lastTestSend.payload.title, 'Family Pulse test');
    assert.equal(lastTestSend.payload.open_url, 'https://pulse.example.test/settings.html');
  });

  it('clears a saved channel', async () => {
    const res = await req(`api/notification-channels/${valId}/brrr`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);

    const listRes = await req('api/notification-channels');
    const data = await listRes.json();
    const member = data.members.find(row => row.member_id === valId);
    assert.equal(member.has_secret, false);
  });
});
