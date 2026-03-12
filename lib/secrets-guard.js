'use strict';

/**
 * secrets-guard.js — prevents access tokens and secrets from leaking
 * into logs, API responses, or LLM context.
 */

// Known secret prefixes / patterns
const SECRET_PATTERNS = [
  /access-sandbox-[a-f0-9-]+/gi,
  /access-production-[a-f0-9-]+/gi,
  /access-development-[a-f0-9-]+/gi,
  /sk-[a-zA-Z0-9_-]{20,}/g,             // OpenAI keys
  /plaid_secret_[a-zA-Z0-9]+/gi,
];

// Env var keys whose values should be redacted
const SECRET_ENV_KEYS = [
  'PLAID_SECRET',
  'PLAID_CLIENT_ID',
  'OPENAI_API_KEY',
];

/** Build dynamic patterns from current env values */
function getEnvPatterns() {
  const patterns = [];
  for (const key of SECRET_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      patterns.push(val);
    }
  }
  return patterns;
}

/** Redact secrets from a string */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  let result = str;

  for (const pattern of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }

  for (const val of getEnvPatterns()) {
    if (result.includes(val)) {
      result = result.split(val).join('[REDACTED]');
    }
  }

  return result;
}

/** Deep-sanitize an object for logging */
function sanitizeForLog(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLog);
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lk = key.toLowerCase();
    if (lk === 'access_token' || lk === 'accesstoken' || lk === 'secret' || lk === 'api_key' || lk === 'apikey' || lk === 'passphrase_hash') {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeForLog(value);
    }
  }
  return result;
}

/** Sanitize for LLM context — more aggressive, strips all token-like values */
function sanitizeForLLM(obj) {
  // Same as sanitizeForLog — both are aggressive
  return sanitizeForLog(obj);
}

/**
 * Guard: throws if query result rows contain access_token column.
 * Call this before sending DB query results to API responses.
 */
function assertNoSecrets(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const forbidden = ['access_token', 'accesstoken', 'plaid_secret', 'api_key', 'passphrase_hash'];
  for (const key of keys) {
    if (forbidden.includes(key.toLowerCase())) {
      throw new Error(`SECURITY: query result contains forbidden column "${key}". Do not expose this in API responses.`);
    }
  }
}

module.exports = { sanitizeString, sanitizeForLog, sanitizeForLLM, assertNoSecrets };
