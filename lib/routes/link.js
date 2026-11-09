'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { OAUTH_COOKIE_NAME } = require('sovereign-auth');
const { pool } = require('../db');
const plaid = require('../plaid-client');
const { syncAll } = require('../sync');
const logger = require('../logger');
const {
  LIABILITY_ACCESS_STATUS,
  deriveLiabilityAccessStatus
} = require('../liability-access');
const {
  ACCOUNT_SELECTION_MODE,
  deriveAccountSelectionState
} = require('../account-selection');

const router = Router();

const LINK_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LINK_PRODUCTS = ['transactions'];
const DEFAULT_ADDITIONAL_CONSENTED_PRODUCTS = ['liabilities'];
const DISCONNECTED_TOKEN_PREFIX = '[DISCONNECTED]';
const REMOVABLE_DISCONNECT_CODES = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']);

// ── Tailnet mode: each link is bound to who started it (wire contract, section 10; D22) ──
// Starting a link (a recent passkey check) records the member, this hostname, and a correlation value that only the
// starting browser holds, in a __Host- cookie that lasts ten minutes. Plaid's bank sign-in return carries no state of
// Pulse's, only Plaid's own oauth_state_id, so the cookie is what says which link a return belongs to: resuming finds
// the link this member started in this browser, at most ten minutes ago, or refuses. Finishing (exchange, complete-*)
// names its link by id and takes it once, used up whatever happens next, but only for the member who started it on this
// hostname: anyone else is refused and uses nothing up. Finishing doesn't need the cookie: the Plaid result it carries
// never passes through an address, and a desktop browser's Link popup can outlast ten minutes. Local mode keeps none of
// this; its passphrase sessions (SameSite=Strict, plain http) can't hold a __Host- cookie.
const OAUTH_MAX_AGE_SECONDS = 600;
const CORRELATION = /^[A-Za-z0-9_-]{43}$/;
const correlationHash = (value) => crypto.createHash('sha256').update(value, 'ascii').digest('base64url');
const correlationCookie = (value, maxAge) => `${OAUTH_COOKIE_NAME}=${value}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;

// The cookie by its exact name (case matters: wire contract, section 7). Two of them is a refusal, not a choice.
function readCorrelation(header) {
  const values = [];
  for (const pair of String(header || '').split(';')) {
    const at = pair.indexOf('=');
    if (at >= 0 && pair.slice(0, at).trim() === OAUTH_COOKIE_NAME) values.push(pair.slice(at + 1).trim());
  }
  if (values.length > 1) return { reason: 'duplicate_cookie' };
  if (!values.length) return { reason: 'no_cookie' };
  return CORRELATION.test(values[0]) ? { value: values[0] } : { reason: 'wrong_correlation' };
}

const oauthRefused = (res, status, reason) => res.status(status).json({ error: 'oauth_refused', reason });

// What a start route records in tailnet mode, after setting the cookie on its answer; nothing in local mode.
function bindToStarter(req, res) {
  if (!req.suiteTailnet) return {};
  const correlation = crypto.randomBytes(32).toString('base64url');
  res.append('Set-Cookie', correlationCookie(correlation, OAUTH_MAX_AGE_SECONDS));
  return { startedBy: req.suiteMember.userId, hostname: req.suiteTailnet.hostname, correlationHash: correlationHash(correlation) };
}

// Every finishing answer in tailnet mode clears the browser's cookie, whatever it says (wire contract, section 10).
function clearCorrelation(req, res) {
  if (req.suiteTailnet) res.append('Set-Cookie', correlationCookie('', 0));
}

// Finishing a link in tailnet mode: take it (pending to 'finishing', once) only for the member who started it on this
// hostname, in one statement. A link's id is a plain counter, so anyone else's attempt must use nothing up: it is
// refused, and the starter can still finish. Answers the refusal itself and returns null, or returns the link. Local
// mode reads it as before.
async function takeSessionToFinish(req, res, sessionId) {
  if (!req.suiteTailnet) {
    const session = await findPendingSessionById(sessionId);
    if (!session) res.status(404).json({ error: 'Link session not found or expired' });
    return session;
  }
  const { rows: [session] } = await pool.query(`
    UPDATE link_sessions SET status = 'finishing'
    WHERE id = $1
      AND status = 'pending'
      AND expires_at > now()
      AND started_by = $2
      AND hostname = $3
    RETURNING id, link_token, owner, item_id_for_update
  `, [sessionId, req.suiteMember.userId, req.suiteTailnet.hostname]);
  if (session) return session;
  // Only to say why: reading changes nothing.
  const pending = await findPendingSessionById(sessionId);
  if (!pending) {
    res.status(404).json({ error: 'Link session not found or expired' });
  } else {
    const { rows: [bound] } = await pool.query('SELECT started_by, hostname FROM link_sessions WHERE id = $1', [pending.id]);
    oauthRefused(res, 403, bound.started_by === req.suiteMember.userId ? 'wrong_hostname' : 'wrong_member');
  }
  return null;
}

async function createLinkSession(sessionData) {
  const expiresAt = new Date(Date.now() + LINK_SESSION_TTL_MS);
  const { rows: [session] } = await pool.query(`
    INSERT INTO link_sessions (link_token, status, owner, item_id_for_update, expires_at, started_by, hostname, correlation_hash)
    VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [
    sessionData.linkToken,
    sessionData.owner || null,
    sessionData.itemIdForUpdate || null,
    expiresAt,
    sessionData.startedBy || null,
    sessionData.hostname || null,
    sessionData.correlationHash || null
  ]);

  return session.id;
}

async function findPendingSessionById(sessionId) {
  const { rows } = await pool.query(`
    SELECT id, link_token, oauth_state_id, owner, item_id_for_update, expires_at
    FROM link_sessions
    WHERE id = $1
      AND status = 'pending'
      AND expires_at > now()
  `, [sessionId]);
  return rows[0] || null;
}

// The one link in progress, if there is exactly one; with several, Pulse won't guess. This only reads. Anyone can put an
// oauth_state_id in a link to the return page, and only Plaid can tell a real one, so a return must change nothing
// until Link succeeds. The exchange then names the session by its id.
async function findResumableSession() {
  const { rows } = await pool.query(`
    SELECT id, link_token
    FROM link_sessions
    WHERE status = 'pending'
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 2
  `);
  return rows.length === 1 ? rows[0] : null;
}

async function markSessionExchanged(sessionId) {
  if (!sessionId) return;
  await pool.query(
    "UPDATE link_sessions SET status = 'exchanged' WHERE id = $1",
    [sessionId]
  );
}

function disconnectedToken(itemId) {
  return `${DISCONNECTED_TOKEN_PREFIX}:${itemId}`;
}

async function refreshItemLiabilityAccess(itemDbId) {
  const { rows: [item] } = await pool.query(
    'SELECT id, access_token FROM items WHERE id = $1',
    [itemDbId]
  );
  if (!item) {
    const err = new Error('Item not found');
    err.statusCode = 404;
    throw err;
  }

  const [itemInfo, accountsData] = await Promise.all([
    plaid.getItemInfo(item.access_token),
    plaid.getAccounts(item.access_token)
  ]);

  const liabilityAccessStatus = deriveLiabilityAccessStatus({
    itemInfo,
    accounts: accountsData.accounts,
    currentStatus: LIABILITY_ACCESS_STATUS.UNKNOWN
  });

  await pool.query(`
    UPDATE items
    SET liability_access_status = $1,
        status = 'good',
        error_code = NULL,
        updated_at = now()
    WHERE id = $2
  `, [liabilityAccessStatus, item.id]);

  return liabilityAccessStatus;
}

async function reconcileItemAccounts(itemId, accounts, owner) {
  const seenAccountIds = new Set();

  for (const acct of accounts) {
    seenAccountIds.add(acct.account_id);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, official_name, type, subtype, mask,
                            current_balance, available_balance, iso_currency_code, owner, sync_status, sync_disabled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', NULL)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        name = EXCLUDED.name,
        official_name = EXCLUDED.official_name,
        type = EXCLUDED.type,
        subtype = EXCLUDED.subtype,
        mask = EXCLUDED.mask,
        current_balance = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        iso_currency_code = EXCLUDED.iso_currency_code,
        -- Link/update flows should honor the owner selected during onboarding or relink.
        owner = COALESCE(EXCLUDED.owner, accounts.owner),
        sync_status = 'active',
        sync_disabled_at = NULL,
        updated_at = now()
    `, [
      acct.account_id, itemId, acct.name, acct.official_name,
      acct.type, acct.subtype, acct.mask,
      acct.balances.current, acct.balances.available,
      acct.balances.iso_currency_code || 'USD',
      owner || null
    ]);
  }

  await pool.query(`
    UPDATE accounts
    SET sync_status = 'historical',
        sync_disabled_at = COALESCE(sync_disabled_at, now()),
        updated_at = now()
    WHERE item_id = $1
      AND plaid_account_id <> ALL($2::text[])
      AND sync_status <> 'historical'
  `, [itemId, Array.from(seenAccountIds)]);

  return seenAccountIds.size;
}

async function refreshItemAccountSelection(itemDbId) {
  const { rows: [item] } = await pool.query(
    `SELECT id, access_token, institution_id, institution_name, status
     FROM items WHERE id = $1`,
    [itemDbId]
  );
  if (!item) {
    const err = new Error('Item not found');
    err.statusCode = 404;
    throw err;
  }

  const accountsData = await plaid.getAccounts(item.access_token);
  const activeCount = await reconcileItemAccounts(item.id, accountsData.accounts, null);
  const selectionState = deriveAccountSelectionState(item);

  return {
    activeCount,
    editMode: selectionState.mode
  };
}

async function completeLink({ publicToken, owner, sessionId }) {
  const exchangeData = await plaid.exchangePublicToken(publicToken);
  const { access_token, item_id } = exchangeData;

  const itemInfo = await plaid.getItemInfo(access_token);
  const institutionId = itemInfo.item.institution_id;
  let institutionName = institutionId;
  try {
    const inst = await plaid.getInstitutionById(institutionId);
    institutionName = inst.name;
  } catch (e) {
    logger.warn('Could not fetch institution name', { institutionId });
  }

  const accountsData = await plaid.getAccounts(access_token);
  const liabilityAccessStatus = deriveLiabilityAccessStatus({
    itemInfo,
    accounts: accountsData.accounts
  });

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status, liability_access_status)
    VALUES ($1, $2, $3, $4, 'good', $5)
    ON CONFLICT (item_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      institution_id = EXCLUDED.institution_id,
      institution_name = EXCLUDED.institution_name,
      status = 'good',
      error_code = NULL,
      disconnected_at = NULL,
      liability_access_status = EXCLUDED.liability_access_status,
      updated_at = now()
    RETURNING id
  `, [access_token, item_id, institutionId, institutionName, liabilityAccessStatus]);

  const accountCount = await reconcileItemAccounts(item.id, accountsData.accounts, owner);

  await markSessionExchanged(sessionId);
  syncAll().catch(err => logger.error('Post-link sync failed', { error: err.message }));

  return {
    success: true,
    item_id: item.id,
    institution_name: institutionName,
    accounts: accountCount
  };
}

// ── POST /api/link/create-token ──────────────────────────────

router.post('/api/link/create-token', async (req, res) => {
  try {
    const { owner } = req.body;

    const data = await plaid.createLinkToken({
      userId: owner || 'family-pulse-user',
      products: DEFAULT_LINK_PRODUCTS,
      additionalConsentedProducts: DEFAULT_ADDITIONAL_CONSENTED_PRODUCTS
    });

    const linkSessionId = await createLinkSession({
      linkToken: data.link_token,
      owner,
      ...bindToStarter(req, res)
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/create-liability-upgrade-token ────────────

router.post('/api/link/create-liability-upgrade-token', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows } = await pool.query(
      'SELECT id, access_token, status FROM items WHERE id = $1',
      [item_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].status === 'disconnected') {
      return res.status(409).json({ error: 'Disconnected institutions cannot be upgraded.' });
    }

    const data = await plaid.createLinkToken({
      accessToken: rows[0].access_token,
      additionalConsentedProducts: DEFAULT_ADDITIONAL_CONSENTED_PRODUCTS
    });

    const linkSessionId = await createLinkSession({
      linkToken: data.link_token,
      itemIdForUpdate: rows[0].id,
      ...bindToStarter(req, res)
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create liability upgrade link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/create-account-selection-token ────────────

router.post('/api/link/create-account-selection-token', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    const { rows } = await pool.query(
      'SELECT id, access_token, status, institution_id, institution_name FROM items WHERE id = $1',
      [item_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    const selectionState = deriveAccountSelectionState(rows[0]);
    if (selectionState.mode === ACCOUNT_SELECTION_MODE.UNAVAILABLE) {
      return res.status(409).json({ error: 'This institution is not currently editable in-app.' });
    }

    const data = await plaid.createLinkToken({
      accessToken: rows[0].access_token,
      update: {
        account_selection_enabled: true
      }
    });

    const linkSessionId = await createLinkSession({
      linkToken: data.link_token,
      itemIdForUpdate: rows[0].id,
      ...bindToStarter(req, res)
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create account selection link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/complete-account-selection ────────────────

router.post('/api/link/complete-account-selection', async (req, res) => {
  clearCorrelation(req, res);
  try {
    const { link_session_id } = req.body;
    if (!link_session_id) return res.status(400).json({ error: 'link_session_id is required' });

    const session = await takeSessionToFinish(req, res, link_session_id);
    if (!session) return undefined;
    if (!session.item_id_for_update) {
      return res.status(409).json({ error: 'Link session is not an item update session' });
    }

    const refreshResult = await refreshItemAccountSelection(session.item_id_for_update);
    await markSessionExchanged(session.id);

    res.json({
      success: true,
      active_accounts: refreshResult.activeCount,
      account_selection_mode: refreshResult.editMode
    });
  } catch (err) {
    logger.error('Failed to complete account selection update', { error: err.message, code: err.code });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── POST /api/link/complete-liability-upgrade ────────────────

router.post('/api/link/complete-liability-upgrade', async (req, res) => {
  clearCorrelation(req, res);
  try {
    const { link_session_id } = req.body;
    if (!link_session_id) return res.status(400).json({ error: 'link_session_id is required' });

    const session = await takeSessionToFinish(req, res, link_session_id);
    if (!session) return undefined;
    if (!session.item_id_for_update) {
      return res.status(409).json({ error: 'Link session is not an item upgrade session' });
    }

    const liabilityAccessStatus = await refreshItemLiabilityAccess(session.item_id_for_update);
    await markSessionExchanged(session.id);

    res.json({
      success: true,
      liability_access_status: liabilityAccessStatus
    });
  } catch (err) {
    logger.error('Failed to complete liability upgrade', { error: err.message, code: err.code });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── POST /api/link/update-token ──────────────────────────────

router.post('/api/link/update-token', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    // Get the Item's access_token
    const { rows } = await pool.query(
      'SELECT id, access_token, status FROM items WHERE id = $1', [item_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].status === 'disconnected') {
      return res.status(409).json({ error: 'Disconnected institutions cannot be re-linked.' });
    }

    const data = await plaid.createLinkToken({
      accessToken: rows[0].access_token
    });

    const linkSessionId = await createLinkSession({
      linkToken: data.link_token,
      itemIdForUpdate: rows[0].id,
      ...bindToStarter(req, res)
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create update link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/exchange ──────────────────────────────────

router.post('/api/link/exchange', async (req, res) => {
  clearCorrelation(req, res);
  try {
    const { public_token, owner, link_session_id } = req.body;
    if (!public_token) return res.status(400).json({ error: 'public_token is required' });
    // Tailnet mode always names the link, so it can be checked against who started it.
    if (req.suiteTailnet && !link_session_id) return res.status(400).json({ error: 'link_session_id is required' });
    let session = null;
    if (link_session_id) {
      session = await takeSessionToFinish(req, res, link_session_id);
      if (!session) return undefined;
    }

    const result = await completeLink({
      publicToken: public_token,
      owner: owner || session?.owner || null,
      sessionId: session?.id || null
    });

    res.json(result);
  } catch (err) {
    logger.error('Token exchange failed', { error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// ── Bank sign-in return (OAuth) ──────────────────────────────
// Plaid sends the browser back from an OAuth bank to PLAID_OAUTH_REDIRECT_URI. That can be a public address (a tunnel
// to this one route), so the route answers anyone: it holds nothing, changes nothing and accepts no POST. It only
// sends the browser on to Pulse's own address (APP_URL), to oauth-return.html. That page changes nothing either, since
// a navigation that started on another site brings no sign-in cookie (they're SameSite=Strict). Its same-origin
// request to POST /api/link/oauth-resume does bring it, and only a signed-in parent gets the link token back. Nothing
// is stored until Link succeeds and the usual exchange runs. In tailnet mode resuming also needs the browser and the
// member that started the link ("Tailnet mode" above), and the return lands on the address Home Base publishes.

const OAUTH_QUERY_MAX = 2048;

// Plaid's return query, exactly as it came (Link must be handed the very URL it redirected to), with exactly one
// usable oauth_state_id. Anything else isn't a return Pulse can finish.
function parseOauthReturn(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > OAUTH_QUERY_MAX || /[\s#]/.test(raw)) return null;
  const ids = new URLSearchParams(raw).getAll('oauth_state_id');
  if (ids.length !== 1 || !ids[0] || ids[0].length > 256 || /[\u0000-\u001f\u007f]/.test(ids[0])) return null;
  return { raw, oauthStateId: ids[0] };
}

// In tailnet mode Pulse's own address is the one Home Base publishes it at.
function oauthReturnPage(req, rawQuery) {
  const appUrl = (req.suiteTailnet ? req.suiteTailnet.appUrl : process.env.APP_URL || '').replace(/\/+$/, '');
  return `${appUrl ? `${appUrl}/` : '../'}oauth-return.html?${rawQuery}`;
}

router.get('/oauth/callback', (req, res) => {
  res.set('cache-control', 'no-store');
  res.set('referrer-policy', 'no-referrer');
  const at = req.originalUrl.indexOf('?');
  const found = parseOauthReturn(at >= 0 ? req.originalUrl.slice(at + 1) : '');
  if (!found) return res.status(400).type('text').send('This isn\'t a bank sign-in Family Pulse can finish. Start again from Settings.');
  res.redirect(303, oauthReturnPage(req, found.raw));
});

// In tailnet mode: the link this member started in this browser (its cookie), on this hostname, at most ten minutes ago.
// Answers the refusal itself and returns null.
async function findBoundSession(req, res) {
  const cookie = readCorrelation(req.headers.cookie);
  if (!cookie.value) {
    oauthRefused(res, 403, cookie.reason);
    return null;
  }
  const { rows: [session] } = await pool.query(`
    SELECT id, link_token, started_by, hostname, (now() - created_at) <= make_interval(secs => $2) AS fresh
    FROM link_sessions
    WHERE correlation_hash = $1
      AND status = 'pending'
      AND expires_at > now()
  `, [correlationHash(cookie.value), OAUTH_MAX_AGE_SECONDS]);
  let reason = null;
  if (!session) reason = 'unknown_state';
  else if (!session.fresh) reason = 'expired';
  else if (session.started_by !== req.suiteMember.userId) reason = 'wrong_member';
  else if (session.hostname !== req.suiteTailnet.hostname) reason = 'wrong_hostname';
  if (reason) {
    oauthRefused(res, 403, reason);
    return null;
  }
  return session;
}

// From oauth-return.html, behind sign-in (a parent: /api/link is parent-only). It writes nothing: the return page posts
// whatever query it was opened with, and Plaid alone decides whether that is a real return.
router.post('/api/link/oauth-resume', async (req, res) => {
  res.set('cache-control', 'no-store');
  const found = parseOauthReturn(req.body?.query);
  if (!found) return res.status(400).json({ error: 'This isn\'t a bank sign-in Family Pulse can finish.' });
  const redirectUri = process.env.PLAID_OAUTH_REDIRECT_URI;
  if (!redirectUri) return res.status(409).json({ error: 'PLAID_OAUTH_REDIRECT_URI isn\'t set, so Pulse can\'t finish a bank sign-in.' });

  try {
    if (req.suiteTailnet) {
      const bound = await findBoundSession(req, res);
      if (!bound) return undefined;
      return res.json({ link_token: bound.link_token, link_session_id: bound.id, received_redirect_uri: `${redirectUri}?${found.raw}` });
    }
    const session = await findResumableSession();
    if (!session) return res.status(409).json({ error: 'Pulse can\'t tell which bank link this finishes. Start it again from Settings.' });
    res.json({
      link_token: session.link_token,
      link_session_id: session.id,
      received_redirect_uri: `${redirectUri}?${found.raw}`
    });
  } catch (err) {
    logger.error('Failed to resume OAuth link', { error: err.message });
    res.status(500).json({ error: 'Pulse couldn\'t resume the bank link.' });
  }
});

// ── DELETE /api/items/:id ────────────────────────────────────

router.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  let item;

  try {
    const { rows } = await pool.query(
      'SELECT id, access_token, item_id, status FROM items WHERE id = $1',
      [id]
    );
    item = rows[0];
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.status === 'disconnected') {
      return res.status(409).json({ error: 'Item already disconnected. Use purge to delete local history.' });
    }

    // Keep Plaid I/O outside the row-locked transaction. removeItem records
    // token usage through the shared pool, which also updates this Item row.
    try {
      await plaid.removeItem(item.access_token);
    } catch (err) {
      if (!REMOVABLE_DISCONNECT_CODES.has(err.code)) {
        throw err;
      }
      logger.warn('Proceeding with local disconnect after remote removal failed', {
        itemId: item.id,
        code: err.code,
        error: err.message
      });
    }
  } catch (err) {
    logger.error('Failed to remove Plaid item', { error: err.message, code: err.code });
    if (err.code === 'PLAID_REQUEST_TIMEOUT') {
      return res.status(504).json({
        error: 'Plaid did not respond in time. The item may still have been removed remotely; refresh Settings before retrying.'
      });
    }
    return res.status(500).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    // Re-lock and verify identity before committing the local lifecycle change.
    await client.query('BEGIN');
    const { rows: [lockedItem] } = await client.query(
      'SELECT id, access_token, item_id, status FROM items WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!lockedItem) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found' });
    }
    if (lockedItem.status === 'disconnected') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Item already disconnected. Use purge to delete local history.' });
    }
    if (lockedItem.access_token !== item.access_token) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Item changed while disconnecting. Refresh Settings before retrying.' });
    }

    await client.query(`
      UPDATE items
      SET access_token = $1,
          status = 'disconnected',
          error_code = NULL,
          sync_cursor = NULL,
          disconnected_at = now(),
          updated_at = now()
      WHERE id = $2
    `, [disconnectedToken(lockedItem.item_id), lockedItem.id]);
    // Preserve the accounts and their transactions, but remove their stale
    // balances from all live-account totals now that this Item cannot sync.
    await client.query(`
      UPDATE accounts
      SET sync_status = 'historical',
          sync_disabled_at = COALESCE(sync_disabled_at, now()),
          updated_at = now()
      WHERE item_id = $1
        AND sync_status <> 'historical'
    `, [lockedItem.id]);
    await client.query('COMMIT');

    res.json({ success: true, disconnected: true, preserved_history: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to finalize item disconnect', { error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/items/:id/purge ──────────────────────────────

router.delete('/api/items/:id/purge', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: [item] } = await pool.query(
      'SELECT id, status FROM items WHERE id = $1',
      [id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.status !== 'disconnected') {
      return res.status(409).json({ error: 'Disconnect the institution before purging local history.' });
    }

    const { rowCount: crossInstitutionPaychecks } = await pool.query(
      `SELECT 1
       FROM paycheck_deposits pd
       JOIN transactions t ON t.id = pd.transaction_id
       JOIN accounts a ON a.id = t.account_id
       WHERE a.item_id = $1
         AND EXISTS (
           SELECT 1 FROM paycheck_deposits sibling
           JOIN transactions sibling_t ON sibling_t.id = sibling.transaction_id
           JOIN accounts sibling_a ON sibling_a.id = sibling_t.account_id
           WHERE sibling.paycheck_event_id = pd.paycheck_event_id
             AND sibling_a.item_id <> $1
         )
       LIMIT 1`, [id]
    );
    if (crossInstitutionPaychecks) {
      return res.status(409).json({
        error: 'This institution has a deposit linked to a paycheck at another institution. Remove or edit that paycheck before purging local history.'
      });
    }

    const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Item not found' });

    res.json({ success: true, purged: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/items/:id/owner ─────────────────────────────────

router.put('/api/items/:id/owner', async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update all accounts belonging to this Item
      const { rows: updatedAccts } = await client.query(
        'UPDATE accounts SET owner = $1, updated_at = now() WHERE item_id = $2 RETURNING id',
        [owner, id]
      );

      if (updatedAccts.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No accounts found for this Item' });
      }

      const accountIds = updatedAccts.map(acct => acct.id);

      // Owner assignment is authoritative for kid scoping on an item:
      // clear stale mappings, then add back the current kid owner if needed.
      await client.query(
        'DELETE FROM account_members WHERE account_id = ANY($1::int[])',
        [accountIds]
      );

      if (owner) {
        const { rows: [member] } = await client.query(
          "SELECT id, role FROM family_members WHERE name = $1",
          [owner]
        );
        if (member && member.role === 'kid') {
          for (const acctId of accountIds) {
            await client.query(
              'INSERT INTO account_members (account_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [acctId, member.id]
            );
          }
        }
      }

      await client.query('COMMIT');
      res.json({ success: true, updated: updatedAccts.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/items/:id/sync ─────────────────────────────────

router.post('/api/items/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT id, access_token, item_id, sync_cursor, status FROM items WHERE id = $1', [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].status === 'disconnected') {
      return res.status(409).json({ error: 'Disconnected institutions cannot be synced.' });
    }

    // Import syncItem from sync module — but it's not exported.
    // Instead, trigger a full sync (small household, fast enough).
    const result = await syncAll();
    res.json({
      ...result,
      synced: result.items,
      transactions_added: result.txns_added,
      transactions_modified: result.txns_modified,
      transactions_removed: result.txns_removed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/items ───────────────────────────────────────────

router.get('/api/items', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.item_id, i.institution_id, i.institution_name, i.status,
             i.error_code, i.last_sync_at, i.created_at, i.disconnected_at,
             i.liability_access_status,
             count(a.id) FILTER (WHERE a.sync_status = 'active')::int AS account_count,
             count(a.id) FILTER (WHERE a.sync_status = 'historical')::int AS historical_account_count,
             mode() WITHIN GROUP (ORDER BY a.owner) AS owner
      FROM items i
      LEFT JOIN accounts a ON a.item_id = i.id
      GROUP BY i.id
      ORDER BY i.institution_name
    `);
    res.json(rows.map((item) => ({
      ...item,
      account_selection: deriveAccountSelectionState(item)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/items/:id/accounts ─────────────────────────────

router.get('/api/items/:id/accounts', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [item] } = await pool.query(
      'SELECT id, institution_name, institution_id, status FROM items WHERE id = $1',
      [id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const { rows: accounts } = await pool.query(`
      SELECT id, plaid_account_id, name, official_name, type, subtype, mask,
             current_balance, available_balance, owner, sync_status, sync_disabled_at
      FROM accounts
      WHERE item_id = $1
      -- Active accounts first, then historical accounts.
      ORDER BY sync_status = 'historical', type, name
    `, [id]);

    res.json({
      item: {
        id: item.id,
        institution_name: item.institution_name,
        institution_id: item.institution_id,
        status: item.status,
        account_selection: deriveAccountSelectionState(item)
      },
      accounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
