'use strict';

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
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(`brrr send failed (${res.status}): ${text || res.statusText}`), {
      statusCode: res.status
    });
  }

  return res;
}

module.exports = {
  maskSecret,
  normalizeBrrrTarget,
  sendBrrrNotification
};
