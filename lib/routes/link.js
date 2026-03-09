'use strict';

const { Router } = require('express');
const path = require('path');
const { pool, withTransaction } = require('../db');
const plaid = require('../plaid-client');
const { syncAll } = require('../sync');
const logger = require('../logger');

const router = Router();

// ── POST /api/link/create-token ──────────────────────────────

router.post('/api/link/create-token', async (req, res) => {
  try {
    const { owner } = req.body;

    const data = await plaid.createLinkToken({
      userId: owner || 'family-pulse-user',
      products: ['transactions', 'liabilities']
    });

    // Store session for OAuth resume
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hours
    await pool.query(`
      INSERT INTO link_sessions (link_token, status, owner, expires_at)
      VALUES ($1, 'pending', $2, $3)
    `, [data.link_token, owner || null, expiresAt]);

    res.json({ link_token: data.link_token, expiration: data.expiration });
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

    // Store session for OAuth resume
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    await pool.query(`
      INSERT INTO link_sessions (link_token, status, item_id_for_update, expires_at)
      VALUES ($1, 'pending', $2, $3)
    `, [data.link_token, rows[0].id, expiresAt]);

    res.json({ link_token: data.link_token, expiration: data.expiration });
  } catch (err) {
    logger.error('Failed to create update link token', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/link/exchange ──────────────────────────────────

router.post('/api/link/exchange', async (req, res) => {
  try {
    const { public_token, owner } = req.body;
    if (!public_token) return res.status(400).json({ error: 'public_token is required' });

    // Exchange for access_token
    const exchangeData = await plaid.exchangePublicToken(public_token);
    const { access_token, item_id } = exchangeData;

    // Get institution info
    const itemInfo = await plaid.getItemInfo(access_token);
    const institutionId = itemInfo.item.institution_id;
    let institutionName = institutionId;
    try {
      const inst = await plaid.getInstitutionById(institutionId);
      institutionName = inst.name;
    } catch (e) {
      logger.warn('Could not fetch institution name', { institutionId });
    }

    // Upsert Item
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

    // Fetch and store initial accounts
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

    // Mark link session as exchanged
    await pool.query(
      "UPDATE link_sessions SET status = 'exchanged' WHERE link_token IN (SELECT link_token FROM link_sessions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1)"
    );

    // Trigger initial sync in background (don't block response)
    syncAll().catch(err => logger.error('Post-link sync failed', { error: err.message }));

    res.json({
      success: true,
      item_id: item.id,
      institution_name: institutionName,
      accounts: accountCount
    });
  } catch (err) {
    logger.error('Token exchange failed', { error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /oauth/callback ──────────────────────────────────────

router.get('/oauth/callback', async (req, res) => {
  // Serves the OAuth callback HTML page.
  // The page re-initializes Plaid Link with receivedRedirectUri to complete the flow.
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'oauth-callback.html'));
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
