#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { pool } = require('../lib/db');
const logger = require('../lib/logger');
const { evaluateNotificationCandidates, getNotificationConfig } = require('../lib/notification-rules');
const { sendBrrrNotification } = require('../lib/notifications');

const dryRun = process.argv.includes('--dry-run');

async function cfg(key) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function logDelivery({ memberId, eventType, sourceKey, status, responseStatus = null, payload = null, errorMessage = null }) {
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

async function updateEventState(candidate, { status, errorMessage = null, cooldownHours = null, sent = false }) {
  const now = new Date();
  const appliedCooldown = Number.isFinite(cooldownHours)
    ? new Date(now.getTime() + (cooldownHours * 60 * 60 * 1000))
    : null;

  await pool.query(`
    INSERT INTO notification_event_state (
      member_id, event_type, source_key, last_delivery_attempt_at, last_sent_at,
      cooldown_until, last_result, last_error, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (member_id, event_type, source_key)
    DO UPDATE SET
      last_delivery_attempt_at = EXCLUDED.last_delivery_attempt_at,
      last_sent_at = COALESCE(EXCLUDED.last_sent_at, notification_event_state.last_sent_at),
      cooldown_until = EXCLUDED.cooldown_until,
      last_result = EXCLUDED.last_result,
      last_error = EXCLUDED.last_error,
      updated_at = now()
  `, [
    candidate.member_id,
    candidate.event_type,
    candidate.source_key,
    now,
    sent ? now : null,
    appliedCooldown,
    status,
    errorMessage
  ]);
}

async function main() {
  const config = await getNotificationConfig(cfg);
  if (config.notifications_enabled !== 'true') {
    console.log('Notifications disabled. Nothing to do.');
    return;
  }

  const candidates = await evaluateNotificationCandidates({ pool, cfg, now: new Date() });
  if (!candidates.length) {
    console.log('Notification foundation active. No live event candidates due.');
    return;
  }

  let sentCount = 0;
  for (const candidate of candidates) {
    if (dryRun) {
      console.log(`[dry-run] ${candidate.event_type} -> member ${candidate.member_id}`);
      continue;
    }

    try {
      const response = await sendBrrrNotification(candidate.target_secret, candidate.payload);
      await logDelivery({
        memberId: candidate.member_id,
        eventType: candidate.event_type,
        sourceKey: candidate.source_key,
        status: 'sent',
        responseStatus: response.status || 200,
        payload: candidate.payload
      });
      await updateEventState(candidate, {
        status: 'sent',
        cooldownHours: candidate.cooldown_hours ?? null,
        sent: true
      });
      sentCount++;
    } catch (err) {
      await logDelivery({
        memberId: candidate.member_id,
        eventType: candidate.event_type,
        sourceKey: candidate.source_key,
        status: 'error',
        payload: candidate.payload,
        errorMessage: err.message,
        responseStatus: err.statusCode || null
      });
      await updateEventState(candidate, {
        status: 'error',
        errorMessage: err.message,
        cooldownHours: 1,
        sent: false
      });
      logger.error('Notification send failed', {
        eventType: candidate.event_type,
        memberId: candidate.member_id,
        error: err.message
      });
    }
  }

  console.log(dryRun
    ? `Dry run complete. ${candidates.length} candidate(s).`
    : `Notification run complete. ${candidates.length} candidate(s), ${sentCount} sent.`);
}

main()
  .catch(err => {
    console.error('Notification run failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
