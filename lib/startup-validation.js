'use strict';

const VALID_PLAID_ENVS = new Set(['sandbox', 'development', 'production']);

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateStartupConfig(env = process.env) {
  const plaidEnv = (env.PLAID_ENV || '').toLowerCase();

  if (!env.PLAID_CLIENT_ID) {
    throw new Error('Missing required env var: PLAID_CLIENT_ID');
  }

  if (!env.PLAID_SECRET) {
    throw new Error('Missing required env var: PLAID_SECRET');
  }

  if (!plaidEnv) {
    throw new Error('Missing required env var: PLAID_ENV');
  }

  if (!VALID_PLAID_ENVS.has(plaidEnv)) {
    throw new Error(`Invalid PLAID_ENV: ${env.PLAID_ENV}`);
  }

  if (plaidEnv !== 'production') return;

  if (!env.PLAID_OAUTH_REDIRECT_URI) {
    throw new Error('PLAID_OAUTH_REDIRECT_URI is required when PLAID_ENV=production');
  }

  if (!isHttpsUrl(env.PLAID_OAUTH_REDIRECT_URI)) {
    throw new Error('PLAID_OAUTH_REDIRECT_URI must be a valid https URL in production');
  }

  if (env.PLAID_OAUTH_REDIRECT_URI.includes('?') || env.PLAID_OAUTH_REDIRECT_URI.includes('#')) {
    throw new Error('PLAID_OAUTH_REDIRECT_URI must not include query params or fragments');
  }

  if (!env.APP_URL) {
    throw new Error('APP_URL is required when PLAID_ENV=production');
  }

  if (!isHttpsUrl(env.APP_URL)) {
    throw new Error('APP_URL must be a valid https URL when PLAID_ENV=production');
  }
}

module.exports = { validateStartupConfig };
