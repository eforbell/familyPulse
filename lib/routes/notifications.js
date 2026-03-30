'use strict';

const { Router } = require('express');
const { requireParent } = require('../auth');
const { pool } = require('../db');
const notifications = require('../notifications');
const {
  EVENT_TYPE_KEYS,
  EVENT_TYPES,
  buildOpenUrl,
  getNotificationConfig,
  normalizeNotificationSubscriptions,
  validateNotificationConfigValue
} = require('../notification-rules');

const router = Router();

function maskChannel(row) {
  return {
    member_id: row.member_id,
    member_name: row.member_name,
    member_role: row.member_role,
    member_avatar: row.member_avatar,
    channel_type: 'brrr',
    label: row.label || '',
    enabled: !!row.enabled,
    has_secret: !!row.target_secret,
    secret_mask: notifications.maskSecret(row.target_secret),
    updated_at: row.updated_at
  };
}

async function getMember(memberId) {
  const { rows } = await pool.query(
    'SELECT id, name, role, avatar_emoji FROM family_members WHERE id = $1',
    [memberId]
  );
  return rows[0] || null;
}

async function listParentChannels() {
  const [membersRes, subscriptionsRes] = await Promise.all([
    pool.query(`
      SELECT
        fm.id AS member_id,
        fm.name AS member_name,
        fm.role AS member_role,
        fm.avatar_emoji AS member_avatar,
        mnc.label,
        mnc.enabled,
        mnc.target_secret,
        mnc.updated_at
      FROM family_members fm
      LEFT JOIN member_notification_channels mnc
        ON mnc.member_id = fm.id AND mnc.channel_type = 'brrr'
      WHERE fm.role = 'parent'
      ORDER BY fm.id
    `),
    pool.query(`
      SELECT member_id, event_type, enabled
      FROM member_notification_subscriptions
      ORDER BY member_id, event_type
    `)
  ]);

  const subscriptionsByMember = new Map();
  for (const row of subscriptionsRes.rows) {
    if (!subscriptionsByMember.has(row.member_id)) {
      subscriptionsByMember.set(row.member_id, {});
    }
    subscriptionsByMember.get(row.member_id)[row.event_type] = !!row.enabled;
  }

  return membersRes.rows.map(row => ({
    ...maskChannel(row),
    subscriptions: normalizeNotificationSubscriptions(subscriptionsByMember.get(row.member_id) || {})
  }));
}

async function logDeliveryAttempt({ memberId, eventType, sourceKey = null, status, responseStatus = null, payload = null, errorMessage = null }) {
  await pool.query(`
    INSERT INTO notification_delivery_log (
      member_id, event_type, source_key, status, response_status, payload_json, error_message
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [
    memberId,
    eventType,
    sourceKey,
    status,
    responseStatus,
    payload ? JSON.stringify(payload) : null,
    errorMessage
  ]);
}

router.get('/api/notification-config', requireParent, async (req, res) => {
  try {
    const cfgReader = req.app.get('cfg');
    const config = await getNotificationConfig(cfgReader);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/notification-config/:key', requireParent, async (req, res) => {
  try {
    const key = req.params.key;
    const normalized = validateNotificationConfigValue(key, req.body?.value);
    const setCfg = req.app.get('setCfg');
    await setCfg(key, normalized);
    res.json({ ok: true, key, value: normalized });
  } catch (err) {
    const status = err.message && err.message.startsWith('Unsupported') ? 400 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.get('/api/notification-channels', requireParent, async (req, res) => {
  try {
    res.json({
      event_types: EVENT_TYPES,
      members: await listParentChannels()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/notification-channels/:memberId/brrr', requireParent, async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) {
      return res.status(400).json({ error: 'Invalid member id' });
    }

    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.role !== 'parent') return res.status(400).json({ error: 'Only parent members can receive Family Pulse notifications in v1' });

    const enabled = req.body?.enabled === true;
    const label = String(req.body?.label || '').trim() || null;
    const secret = req.body?.secret;

    const existing = await pool.query(
      'SELECT target_secret FROM member_notification_channels WHERE member_id = $1 AND channel_type = $2',
      [memberId, 'brrr']
    );
    const existingSecret = existing.rows[0]?.target_secret || null;
    const nextSecret = secret === undefined ? existingSecret : String(secret || '').trim() || null;

    if (enabled && !nextSecret) {
      return res.status(400).json({ error: 'A brrr secret or webhook URL is required before notifications can be enabled' });
    }
    if (nextSecret && nextSecret.length < 12) {
      return res.status(400).json({ error: 'brrr secret looks too short' });
    }

    const { rows: [row] } = await pool.query(`
      INSERT INTO member_notification_channels (member_id, channel_type, label, target_secret, enabled, updated_at)
      VALUES ($1, 'brrr', $2, $3, $4, now())
      ON CONFLICT (member_id, channel_type)
      DO UPDATE SET
        label = EXCLUDED.label,
        target_secret = EXCLUDED.target_secret,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING member_id, label, enabled, target_secret, updated_at
    `, [memberId, label, nextSecret, enabled]);

    res.json(maskChannel({
      member_id: row.member_id,
      member_name: member.name,
      member_role: member.role,
      member_avatar: member.avatar_emoji,
      ...row
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/notification-channels/:memberId/brrr', requireParent, async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) {
      return res.status(400).json({ error: 'Invalid member id' });
    }
    await pool.query(
      'DELETE FROM member_notification_channels WHERE member_id = $1 AND channel_type = $2',
      [memberId, 'brrr']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/notification-subscriptions/:memberId', requireParent, async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) {
      return res.status(400).json({ error: 'Invalid member id' });
    }

    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.role !== 'parent') return res.status(400).json({ error: 'Only parent members can receive Family Pulse notifications in v1' });

    const subscriptions = normalizeNotificationSubscriptions(req.body?.subscriptions || {});
    for (const key of Object.keys(req.body?.subscriptions || {})) {
      if (!EVENT_TYPE_KEYS.has(key)) {
        return res.status(400).json({ error: `Unknown event type: ${key}` });
      }
    }

    for (const [eventType, enabled] of Object.entries(subscriptions)) {
      await pool.query(`
        INSERT INTO member_notification_subscriptions (member_id, event_type, enabled, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (member_id, event_type)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      `, [memberId, eventType, enabled]);
    }

    res.json({ ok: true, member_id: memberId, subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/notification-channels/:memberId/brrr/test', requireParent, async (req, res) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) {
      return res.status(400).json({ error: 'Invalid member id' });
    }

    const member = await getMember(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.role !== 'parent') return res.status(400).json({ error: 'Only parent members can receive Family Pulse notifications in v1' });

    const { rows: [channel] } = await pool.query(`
      SELECT target_secret, enabled
      FROM member_notification_channels
      WHERE member_id = $1 AND channel_type = 'brrr'
    `, [memberId]);

    if (!channel?.target_secret) {
      return res.status(400).json({ error: 'Save a brrr secret first' });
    }
    if (!channel.enabled) {
      return res.status(400).json({ error: 'Enable this member channel before sending a test notification' });
    }

    const cfgReader = req.app.get('cfg');
    const config = await getNotificationConfig(cfgReader);
    const payload = {
      title: 'Family Pulse test',
      subtitle: member.name,
      message: 'Your Family Pulse notifications are connected.',
      'interruption-level': config.notification_default_interruption_level
    };

    const openUrl = buildOpenUrl(config.notification_base_url, 'settings.html');
    if (openUrl) payload.open_url = openUrl;

    try {
      const response = await notifications.sendBrrrNotification(channel.target_secret, payload);
      await logDeliveryAttempt({
        memberId,
        eventType: 'test',
        sourceKey: 'manual:test',
        status: 'sent',
        responseStatus: response.status,
        payload
      });
      res.json({ ok: true });
    } catch (err) {
      await logDeliveryAttempt({
        memberId,
        eventType: 'test',
        sourceKey: 'manual:test',
        status: 'error',
        responseStatus: err.statusCode || null,
        payload,
        errorMessage: err.message
      });
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
