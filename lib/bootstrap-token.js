'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 20 * 60 * 1000;
const activeTokens = new Map();

function nowMs() {
  return Date.now();
}

function pruneExpired() {
  const now = nowMs();
  for (const [token, expiresAt] of activeTokens.entries()) {
    if (expiresAt <= now) activeTokens.delete(token);
  }
}

function issueBootstrapToken() {
  pruneExpired();
  const token = `${crypto.randomUUID()}-${crypto.randomBytes(16).toString('hex')}`;
  activeTokens.set(token, nowMs() + TOKEN_TTL_MS);
  return token;
}

function hasValidBootstrapToken(token) {
  if (!token) return false;
  pruneExpired();
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= nowMs()) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

function consumeBootstrapToken(token) {
  if (!token) return false;
  const valid = hasValidBootstrapToken(token);
  if (!valid) return false;
  activeTokens.delete(token);
  return true;
}

module.exports = {
  TOKEN_TTL_MS,
  issueBootstrapToken,
  hasValidBootstrapToken,
  consumeBootstrapToken,
};
