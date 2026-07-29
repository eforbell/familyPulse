'use strict';

const { Router } = require('express');
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

function settingsUrl() {
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  return appUrl ? `${appUrl}/settings.html` : '';
}

async function createLinkSession(sessionData) {
  const expiresAt = new Date(Date.now() + LINK_SESSION_TTL_MS);
  const { rows: [session] } = await pool.query(`
    INSERT INTO link_sessions (link_token, status, owner, item_id_for_update, expires_at)
    VALUES ($1, 'pending', $2, $3, $4)
    RETURNING id
  `, [
    sessionData.linkToken,
    sessionData.owner || null,
    sessionData.itemIdForUpdate || null,
    expiresAt
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

async function findOrBindOauthSession(oauthStateId) {
  const { rows: exactRows } = await pool.query(`
    SELECT id, link_token, oauth_state_id, owner, item_id_for_update, expires_at
    FROM link_sessions
    WHERE oauth_state_id = $1
      AND status = 'pending'
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `, [oauthStateId]);
  if (exactRows[0]) return exactRows[0];

  const { rows: pendingRows } = await pool.query(`
    SELECT id, link_token, oauth_state_id, owner, item_id_for_update, expires_at
    FROM link_sessions
    WHERE oauth_state_id IS NULL
      AND status = 'pending'
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 2
  `);

  if (pendingRows.length !== 1) return null;

  const { rows: [boundSession] } = await pool.query(`
    UPDATE link_sessions
    SET oauth_state_id = $1
    WHERE id = $2
      AND oauth_state_id IS NULL
    RETURNING id, link_token, oauth_state_id, owner, item_id_for_update, expires_at
  `, [oauthStateId, pendingRows[0].id]);

  return boundSession || null;
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

function renderOauthCallbackPage({ linkToken, oauthStateId }) {
  const backUrl = settingsUrl();
  const linkTokenJson = JSON.stringify(String(linkToken));
  const oauthStateIdJson = JSON.stringify(String(oauthStateId));
  const backUrlJson = JSON.stringify(String(backUrl));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0f172a">
  <title>Family Pulse | Completing Connection</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f4ed;
      --card: #fffdf8;
      --text: #1b1d21;
      --muted: #5e6470;
      --accent: #1d6b57;
      --border: rgba(27, 29, 33, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(29, 107, 87, 0.14), transparent 40%),
        linear-gradient(180deg, #faf7ef 0%, var(--bg) 100%);
      font-family: Georgia, "Times New Roman", serif;
      color: var(--text);
      padding: 24px;
    }
    .card {
      width: min(100%, 520px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px 28px;
      box-shadow: 0 18px 48px rgba(16, 24, 40, 0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.9rem;
      font-weight: 600;
    }
    p {
      margin: 0;
      line-height: 1.5;
      color: var(--muted);
    }
    .status {
      margin-top: 22px;
      min-height: 48px;
    }
    .pulse {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--accent);
      font-weight: 600;
    }
    .pulse::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: currentColor;
      animation: pulse 1s ease-in-out infinite;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    @keyframes pulse {
      0%, 100% { transform: scale(0.85); opacity: 0.5; }
      50% { transform: scale(1.15); opacity: 1; }
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Completing bank connection</h1>
    <p>Family Pulse is resuming your Plaid session and finishing the account link.</p>
    <div class="status" id="status"><div class="pulse">Reconnecting to Plaid...</div></div>
  </main>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    'use strict';

    const linkToken = ${linkTokenJson};
    const oauthStateId = ${oauthStateIdJson};
    const backUrl = ${backUrlJson};
    const statusEl = document.getElementById('status');

    function backLink(text) {
      return backUrl ? ' <a href="' + backUrl + '">'+ text +'</a>' : '';
    }

    const handler = Plaid.create({
      token: linkToken,
      receivedRedirectUri: window.location.href,
      onSuccess: async (publicToken) => {
        statusEl.innerHTML = '<div class="pulse">Linking accounts...</div>';
        try {
          const response = await fetch('/oauth/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token: publicToken,
              oauth_state_id: oauthStateId
            })
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(data.error || 'Exchange failed');
          }

          statusEl.innerHTML = '<div>Connected.' + backLink('Return to Settings') + '</div>';
        } catch (err) {
          statusEl.innerHTML = '<div>Connection failed: ' + err.message + '.' + backLink('Return to Settings') + '</div>';
        }
      },
      onExit: (err) => {
        const message = err ? (err.display_message || err.error_code || 'Connection interrupted') : 'Connection cancelled';
        statusEl.innerHTML = '<div>' + message + '.' + backLink('Return to Settings') + '</div>';
      }
    });

    handler.open();
  </script>
</body>
</html>`;
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
      owner
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
      itemIdForUpdate: rows[0].id
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
      itemIdForUpdate: rows[0].id
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create account selection link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/complete-account-selection ────────────────

router.post('/api/link/complete-account-selection', async (req, res) => {
  try {
    const { link_session_id } = req.body;
    if (!link_session_id) return res.status(400).json({ error: 'link_session_id is required' });

    const session = await findPendingSessionById(link_session_id);
    if (!session) return res.status(404).json({ error: 'Link session not found or expired' });
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
  try {
    const { link_session_id } = req.body;
    if (!link_session_id) return res.status(400).json({ error: 'link_session_id is required' });

    const session = await findPendingSessionById(link_session_id);
    if (!session) return res.status(404).json({ error: 'Link session not found or expired' });
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
      itemIdForUpdate: rows[0].id
    });

    res.json({ link_token: data.link_token, expiration: data.expiration, link_session_id: linkSessionId });
  } catch (err) {
    logger.error('Failed to create update link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/exchange ──────────────────────────────────

router.post('/api/link/exchange', async (req, res) => {
  try {
    const { public_token, owner, link_session_id } = req.body;
    if (!public_token) return res.status(400).json({ error: 'public_token is required' });
    let session = null;
    if (link_session_id) {
      session = await findPendingSessionById(link_session_id);
      if (!session) return res.status(404).json({ error: 'Link session not found or expired' });
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

// ── GET /oauth/callback ──────────────────────────────────────

router.get('/oauth/callback', async (req, res) => {
  const { oauth_state_id: oauthStateId } = req.query;
  if (!oauthStateId) return res.status(400).send('Missing oauth_state_id');

  try {
    const session = await findOrBindOauthSession(oauthStateId);
    if (!session) {
      return res.status(409).send('Unable to resume OAuth session. Start the Plaid link flow again.');
    }

    res.type('html').send(renderOauthCallbackPage({
      linkToken: session.link_token,
      oauthStateId
    }));
  } catch (err) {
    logger.error('Failed to resume OAuth callback', { error: err.message });
    res.status(500).send('Failed to resume OAuth callback');
  }
});

router.post('/oauth/callback', async (req, res) => {
  try {
    const { public_token: publicToken, oauth_state_id: oauthStateId } = req.body;
    if (!publicToken) return res.status(400).json({ error: 'public_token is required' });
    if (!oauthStateId) return res.status(400).json({ error: 'oauth_state_id is required' });

    const session = await findOrBindOauthSession(oauthStateId);
    if (!session) return res.status(404).json({ error: 'OAuth session not found or expired' });

    const result = await completeLink({
      publicToken,
      owner: session.owner || null,
      sessionId: session.id
    });

    res.json(result);
  } catch (err) {
    logger.error('OAuth callback exchange failed', { error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/items/:id ────────────────────────────────────

router.delete('/api/items/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');
    const { rows: [item] } = await client.query(
      'SELECT id, access_token, item_id, status FROM items WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!item) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.status === 'disconnected') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Item already disconnected. Use purge to delete local history.' });
    }

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

    await client.query(`
      UPDATE items
      SET access_token = $1,
          status = 'disconnected',
          error_code = NULL,
          sync_cursor = NULL,
          disconnected_at = now(),
          updated_at = now()
      WHERE id = $2
    `, [disconnectedToken(item.item_id), item.id]);
    // Preserve the accounts and their transactions, but remove their stale
    // balances from all live-account totals now that this Item cannot sync.
    await client.query(`
      UPDATE accounts
      SET sync_status = 'historical',
          sync_disabled_at = COALESCE(sync_disabled_at, now()),
          updated_at = now()
      WHERE item_id = $1
        AND sync_status <> 'historical'
    `, [item.id]);
    await client.query('COMMIT');

    res.json({ success: true, disconnected: true, preserved_history: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to disconnect item', { error: err.message, code: err.code });
    if (err.code === 'PLAID_REQUEST_TIMEOUT') {
      return res.status(504).json({
        error: 'Plaid did not respond in time. The item may still have been removed remotely; refresh Settings before retrying.'
      });
    }
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
