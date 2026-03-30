'use strict';

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const normalized = { ...payload };

  if (!normalized.message && typeof normalized.body === 'string' && normalized.body.trim()) {
    normalized.message = normalized.body;
  }
  delete normalized.body;

  if (!normalized.interruption_level && typeof normalized['interruption-level'] === 'string') {
    normalized.interruption_level = normalized['interruption-level'];
  }
  delete normalized['interruption-level'];

  return normalized;
}

function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new Error('Missing brrr target');
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return `https://api.brrr.now/v1/${raw}`;
}

function maskSecret(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) return '';

  let maskSource = raw;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.split('/').filter(Boolean);
      maskSource = parts[parts.length - 1] || raw;
    } catch {
      maskSource = raw;
    }
  }

  if (maskSource.length <= 4) return 'saved';
  return `••••${maskSource.slice(-4)}`;
}

async function sendBrrrNotification(secretOrUrl, payload) {
  const targetUrl = normalizeBrrrTarget(secretOrUrl);
  const normalizedPayload = normalizePayload(payload);
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizedPayload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(`brrr send failed (${res.status}): ${text || res.statusText}`), {
      statusCode: res.status
    });
  }

  return res;
}

async function logNotificationDelivery(db, { memberId, eventType, sourceKey = null, status, responseStatus = null, payload = null, errorMessage = null }) {
  await db.query(`
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

module.exports = {
  logNotificationDelivery,
  maskSecret,
  normalizePayload,
  normalizeBrrrTarget,
  sendBrrrNotification
};
