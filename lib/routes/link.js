'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const plaid = require('../plaid-client');
const { syncAll } = require('../sync');
const logger = require('../logger');

const router = Router();

const LINK_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

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

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ($1, $2, $3, $4, 'good')
    ON CONFLICT (item_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      institution_id = EXCLUDED.institution_id,
      institution_name = EXCLUDED.institution_name,
      status = 'good',
      error_code = NULL,
      updated_at = now()
    RETURNING id
  `, [access_token, item_id, institutionId, institutionName]);

  const accountsData = await plaid.getAccounts(access_token);
  let accountCount = 0;
  for (const acct of accountsData.accounts) {
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, official_name, type, subtype, mask,
                            current_balance, available_balance, iso_currency_code, owner)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (plaid_account_id) DO UPDATE SET
        name = EXCLUDED.name, official_name = EXCLUDED.official_name,
        current_balance = EXCLUDED.current_balance, available_balance = EXCLUDED.available_balance,
        owner = COALESCE(EXCLUDED.owner, accounts.owner),
        updated_at = now()
    `, [
      acct.account_id, item.id, acct.name, acct.official_name,
      acct.type, acct.subtype, acct.mask,
      acct.balances.current, acct.balances.available,
      acct.balances.iso_currency_code || 'USD',
      owner || null
    ]);
    accountCount++;
  }

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
      products: ['transactions', 'liabilities']
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

// ── POST /api/link/update-token ──────────────────────────────

router.post('/api/link/update-token', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'item_id is required' });

    // Get the Item's access_token
    const { rows } = await pool.query(
      'SELECT id, access_token FROM items WHERE id = $1', [item_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

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
  try {
    const { id } = req.params;

    // Cascade: transactions → accounts → item (FK ON DELETE CASCADE handles it)
    const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Item not found' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/items/:id/owner ─────────────────────────────────

router.put('/api/items/:id/owner', async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.body;

    // Update all accounts belonging to this Item
    const { rowCount } = await pool.query(
      'UPDATE accounts SET owner = $1, updated_at = now() WHERE item_id = $2',
      [owner, id]
    );

    if (rowCount === 0) return res.status(404).json({ error: 'No accounts found for this Item' });

    res.json({ success: true, updated: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/items/:id/sync ─────────────────────────────────

router.post('/api/items/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT id, access_token, item_id, sync_cursor FROM items WHERE id = $1', [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    // Import syncItem from sync module — but it's not exported.
    // Instead, trigger a full sync (small household, fast enough).
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/items ───────────────────────────────────────────

router.get('/api/items', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.item_id, i.institution_id, i.institution_name, i.status,
             i.error_code, i.last_sync_at, i.created_at,
             count(a.id)::int AS account_count
      FROM items i
      LEFT JOIN accounts a ON a.item_id = i.id
      GROUP BY i.id
      ORDER BY i.institution_name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
