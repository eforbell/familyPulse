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

// BRRR_ICON_URL replaces the brrr icon on iOS. It is fetched from outside the
// tailnet, so it must be publicly reachable (e.g. a CDN), not notification_base_url.
function withIconUrl(payload, iconUrl = process.env.BRRR_ICON_URL) {
  const url = String(iconUrl || '').trim();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (payload.icon_url || !isHttpUrl(url)) return payload;
  return { ...payload, icon_url: url };
}

function isHttpUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && Boolean(hostname);
  } catch {
    return false;
  }
}

// The one brrr-compatible push service this install sends through (PUSH_BASE_URL, default brrr). A malformed
// value is an error, not a fallback: falling back would send a self-hosted service's secrets to brrr.
const DEFAULT_PUSH_BASE_URL = 'https://api.brrr.now';

function pushBaseUrl(value = process.env.PUSH_BASE_URL) {
  if (value === undefined || value === null || value === '') return DEFAULT_PUSH_BASE_URL;
  const raw = String(value).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('PUSH_BASE_URL is not a valid URL'); }
  // Checks raw, not url.search and url.hash: those are empty for a URL ending in a bare "?" or "#".
  if (!['http:', 'https:'].includes(url.protocol) || /[?#]/.test(raw) || url.username || url.password) {
    throw new Error('PUSH_BASE_URL must be a plain http(s) URL');
  }
  return url.href.replace(/\/+$/, '');
}

// A saved full URL must belong to the configured service. One left over from another service is refused
// rather than sent, so a switchover can't quietly leave someone on the old service.
function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new Error('Missing brrr target');
  const prefix = `${pushBaseUrl()}/v1/`;
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('This saved push target is not a valid secret or URL.');
    return `${prefix}${raw}`;
  }
  let href = '';
  try { href = new URL(raw).href; } catch { /* refused below */ }
  if (!href.startsWith(prefix) || href === prefix) {
    throw new Error('This saved push target is for a different push service. Save a new secret from the current one.');
  }
  return raw;
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

// The service's error text can quote the request path, and the secret is in that path.
function withoutSecret(text, targetUrl) {
  return String(text).split(targetUrl.slice(targetUrl.lastIndexOf('/') + 1)).join('[secret]');
}

async function sendBrrrNotification(secretOrUrl, payload) {
  const targetUrl = normalizeBrrrTarget(secretOrUrl);
  const normalizedPayload = withIconUrl(normalizePayload(payload));
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizedPayload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(`brrr send failed (${res.status}): ${withoutSecret(text || res.statusText, targetUrl)}`), {
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
  pushBaseUrl,
  logNotificationDelivery,
  maskSecret,
  normalizePayload,
  normalizeBrrrTarget,
  sendBrrrNotification,
  withIconUrl
};
