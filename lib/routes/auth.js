'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const {
  hashPassphrase,
  verifyPassphrase,
  createSession,
  destroySession,
  authEnabled,
  requireAuth,
  requireParent,
  SESSION_DAYS,
  parseCookie
} = require('../auth');
const {
  hasValidBootstrapToken,
  consumeBootstrapToken,
} = require('../bootstrap-token');

// ── POST /api/auth/login ────────────────────────────────────

router.post('/api/auth/login', async (req, res) => {
  try {
    const { member_id, passphrase } = req.body;
    if (!member_id) {
      return res.status(400).json({ error: 'member_id required' });
    }

    const { rows } = await pool.query(
      'SELECT id, name, role, avatar_emoji, passphrase_hash FROM family_members WHERE id = $1',
      [member_id]
    );
    const member = rows[0];
    if (!member) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isAuthOn = await authEnabled();

    if (isAuthOn) {
      // Auth is enabled — passphrase required
      if (!passphrase) {
        return res.status(400).json({ error: 'Passphrase required' });
      }
      if (!member.passphrase_hash) {
        return res.status(401).json({ error: 'Passphrase not set for this member' });
      }
      if (!verifyPassphrase(passphrase, member.passphrase_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }
    // If auth is not enabled, allow login without passphrase (pre-auth member picker)

    const session = await createSession(member.id);
    res.cookie('fp_session', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      path: '/'
    });

    res.json({
      id: member.id,
      name: member.name,
      role: member.role,
      avatar_emoji: member.avatar_emoji
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────

router.post('/api/auth/logout', async (req, res) => {
  try {
    const token = parseCookie(req.headers.cookie, 'fp_session');
    await destroySession(token);
    res.clearCookie('fp_session', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────

router.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.member.id,
    name: req.member.name,
    role: req.member.role,
    avatar_emoji: req.member.avatar_emoji
  });
});

// ── PUT /api/auth/passphrase — parent sets passphrase for any member ──

// Allow passphrase setup when auth isn't enabled yet (first-time bootstrapping),
// but requires BOOTSTRAP_SECRET env var as a one-time setup token to prevent
// first-writer takeover by unauthorized visitors.
// Once auth is enabled, requires parent session.
async function requireParentOrBootstrap(req, res, next) {
  const isAuthOn = await authEnabled();
  if (!isAuthOn) {
    // Bootstrap mode: require either BOOTSTRAP_SECRET or a short-lived bootstrap token cookie.
    const bootstrapSecret = process.env.BOOTSTRAP_SECRET;
    const providedSecret = req.headers['x-bootstrap-secret'] || req.body?.bootstrap_secret;
    const bootstrapToken = parseCookie(req.headers.cookie, 'fp_bootstrap_token');
    const hasValidToken = hasValidBootstrapToken(bootstrapToken);
    const hasSecret = Boolean(bootstrapSecret && providedSecret === bootstrapSecret);

    if (!hasSecret && !hasValidToken) {
      if (!bootstrapSecret) {
        return res.status(403).json({
          error: 'Bootstrap authorization required. Complete household setup first or provide X-Bootstrap-Secret.',
        });
      }
      return res.status(403).json({ error: 'Invalid bootstrap secret' });
    }

    // Carry through token status for one-time consume on successful passphrase set.
    req.bootstrapTokenAuthorized = hasValidToken;
    req.bootstrapTokenValue = bootstrapToken;
    // Only allow setting passphrase for parent-role members
    const { member_id } = req.body || {};
    if (member_id) {
      const { rows } = await pool.query(
        'SELECT role FROM family_members WHERE id = $1', [member_id]
      );
      if (rows.length === 0 || rows[0].role !== 'parent') {
        return res.status(403).json({ error: 'First passphrase must be set for a parent' });
      }
    }
    return next();
  }
  return requireParent(req, res, next);
}

router.put('/api/auth/passphrase', requireParentOrBootstrap, async (req, res) => {
  try {
    const { member_id, passphrase } = req.body;
    if (!member_id || !passphrase) {
      return res.status(400).json({ error: 'member_id and passphrase required' });
    }
    if (passphrase.length < 4) {
      return res.status(400).json({ error: 'Passphrase must be at least 4 characters' });
    }

    const hash = hashPassphrase(passphrase);
    const { rowCount } = await pool.query(
      'UPDATE family_members SET passphrase_hash = $1 WHERE id = $2',
      [hash, member_id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (req.bootstrapTokenAuthorized && req.bootstrapTokenValue) {
      consumeBootstrapToken(req.bootstrapTokenValue);
      res.clearCookie('fp_bootstrap_token', { path: '/' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/members — public list for login screen ────

router.get('/api/auth/members', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, avatar_emoji,
              (passphrase_hash IS NOT NULL) AS has_passphrase
       FROM family_members ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account-member linking (for kid scoping) ────────────────

router.get('/api/auth/account-members', requireParent, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT am.account_id, am.member_id, a.name AS account_name, a.mask,
              m.name AS member_name, m.avatar_emoji
       FROM account_members am
       JOIN accounts a ON am.account_id = a.id
       JOIN family_members m ON am.member_id = m.id
       ORDER BY m.name, a.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/auth/account-members', requireParent, async (req, res) => {
  try {
    const { member_id, account_ids } = req.body;
    if (!member_id || !Array.isArray(account_ids)) {
      return res.status(400).json({ error: 'member_id and account_ids[] required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM account_members WHERE member_id = $1', [member_id]);
      for (const acctId of account_ids) {
        await client.query(
          'INSERT INTO account_members (account_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [acctId, member_id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
