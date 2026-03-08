'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { assertNoSecrets } = require('../secrets-guard');

const router = Router();

// ── GET /api/accounts ────────────────────────────────────────

router.get('/api/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.name, a.official_name, a.type, a.subtype, a.mask,
             a.current_balance, a.available_balance, a.iso_currency_code, a.owner,
             i.institution_name, i.status AS item_status
      FROM accounts a
      JOIN items i ON a.item_id = i.id
      ORDER BY i.institution_name, a.name
    `);
    assertNoSecrets(rows);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/accounts/dashboard ──────────────────────────────

router.get('/api/accounts/dashboard', async (req, res) => {
  try {
    const memberName = req.query.member || null;

    // Look up member role if provided
    let memberRole = 'parent';
    if (memberName) {
      const { rows: memberRows } = await pool.query(
        'SELECT role FROM family_members WHERE name = $1', [memberName]
      );
      if (memberRows.length > 0) memberRole = memberRows[0].role;
    }

    const { rows } = await pool.query(`
      SELECT a.id, a.name, a.official_name, a.type, a.subtype, a.mask,
             a.current_balance, a.available_balance, a.owner,
             i.institution_name
      FROM accounts a
      JOIN items i ON a.item_id = i.id
      ORDER BY a.owner NULLS LAST, i.institution_name, a.name
    `);

    assertNoSecrets(rows);

    // Filter for kid visibility
    let filtered = rows;
    if (memberRole === 'kid' && memberName) {
      filtered = rows.filter(a => a.owner === memberName);
    }

    // Group by owner
    const groups = {};
    let liquidTotal = 0;
    let creditTotal = 0;

    for (const acct of filtered) {
      const owner = acct.owner || 'Household';
      if (!groups[owner]) groups[owner] = [];
      groups[owner].push(acct);

      const bal = parseFloat(acct.current_balance) || 0;
      if (acct.type === 'depository' || acct.type === 'investment') {
        liquidTotal += bal;
      } else if (acct.type === 'credit') {
        creditTotal += bal;
      }
    }

    res.json({
      groups,
      liquid_total: liquidTotal,
      credit_total: creditTotal,
      net_position: liquidTotal - creditTotal,
      account_count: filtered.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/family-members ──────────────────────────────────

router.get('/api/family-members', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, role, avatar_emoji, color FROM family_members ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
