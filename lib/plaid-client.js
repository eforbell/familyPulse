'use strict';

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const logger = require('./logger');
const { pool } = require('./db');

// ── Initialize Plaid client ──────────────────────────────────

const plaidEnv = (process.env.PLAID_ENV || 'sandbox').toLowerCase();

const configuration = new Configuration({
  basePath: PlaidEnvironments[plaidEnv] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    }
  }
});

const client = new PlaidApi(configuration);

// ── Token usage tracking ─────────────────────────────────────

async function touchToken(accessToken) {
  try {
    await pool.query(
      'UPDATE items SET token_last_used_at = now() WHERE access_token = $1',
      [accessToken]
    );
  } catch (err) {
    logger.warn('Failed to update token_last_used_at', { error: err.message });
  }
}

// ── Plaid API wrappers ───────────────────────────────────────

async function getAccounts(accessToken) {
  logger.info('Plaid: fetching accounts');
  await touchToken(accessToken);
  try {
    const response = await client.accountsGet({ access_token: accessToken });
    return response.data;
  } catch (err) {
    throw mapPlaidError(err);
  }
}

async function syncTransactions(accessToken, cursor) {
  logger.info('Plaid: syncing transactions', { hasCursor: !!cursor });
  await touchToken(accessToken);

  const allAdded = [];
  const allModified = [];
  const allRemoved = [];
  let nextCursor = cursor;
  let hasMore = true;

  try {
    while (hasMore) {
      const request = { access_token: accessToken };
      if (nextCursor) request.cursor = nextCursor;

      const response = await client.transactionsSync(request);
      const data = response.data;

      allAdded.push(...data.added);
      allModified.push(...data.modified);
      allRemoved.push(...data.removed);
      nextCursor = data.next_cursor;
      hasMore = data.has_more;
    }

    return {
      added: allAdded,
      modified: allModified,
      removed: allRemoved,
      cursor: nextCursor
    };
  } catch (err) {
    throw mapPlaidError(err);
  }
}

async function getLiabilities(accessToken) {
  logger.info('Plaid: fetching liabilities');
  await touchToken(accessToken);
  try {
    const response = await client.liabilitiesGet({ access_token: accessToken });
    return response.data;
  } catch (err) {
    // PRODUCT_NOT_READY or PRODUCTS_NOT_SUPPORTED are expected for non-credit items
    if (err.response?.data?.error_code === 'PRODUCTS_NOT_SUPPORTED' ||
        err.response?.data?.error_code === 'PRODUCT_NOT_READY') {
      return null;
    }
    throw mapPlaidError(err);
  }
}

// ── Error mapping ────────────────────────────────────────────

function mapPlaidError(err) {
  const plaidError = err.response?.data;
  if (plaidError) {
    const appError = new Error(plaidError.error_message || 'Plaid API error');
    appError.code = plaidError.error_code;
    appError.type = plaidError.error_type;
    appError.plaidRequestId = plaidError.request_id;
    return appError;
  }
  return err;
}

module.exports = { getAccounts, syncTransactions, getLiabilities, client };
