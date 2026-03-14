'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { assertNoSecrets } = require('../secrets-guard');
const { getCoverage } = require('../coverage-calculator');
const { requireParent } = require('../auth');

const router = Router();

// ── GET /api/accounts/coverage ────────────────────────────────

router.get('/api/accounts/coverage', requireParent, async (req, res) => {
  try {
    const coverage = await getCoverage();
    res.json(coverage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/accounts ────────────────────────────────────────

router.get('/api/accounts', async (req, res) => {
  try {
    const member = req.member;
    const isKid = member && member.role === 'kid';

    let query = `
      SELECT a.id, a.name, a.custom_name, COALESCE(a.custom_name, a.name) AS display_name,
             a.official_name, a.type, a.subtype, a.mask,
             a.current_balance, a.available_balance, a.iso_currency_code, a.owner,
             a.last_statement_balance, a.minimum_payment_amount,
             a.next_payment_due_date, a.is_overdue,
             i.institution_name, i.status AS item_status
      FROM accounts a
      JOIN items i ON a.item_id = i.id`;
    const params = [];

    if (isKid) {
      query += ` JOIN account_members am ON am.account_id = a.id AND am.member_id = $1`;
      params.push(member.id);
    }

    query += ` ORDER BY i.institution_name, a.name`;

    const { rows } = await pool.query(query, params);
    assertNoSecrets(rows);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/accounts/dashboard ──────────────────────────────

router.get('/api/accounts/dashboard', async (req, res) => {
  try {
    const member = req.member; // from session middleware
    const isKid = member && member.role === 'kid';

    let rows;
    if (isKid) {
      // Kids only see their linked accounts (via account_members table)
      const result = await pool.query(`
        SELECT a.id, a.name, a.custom_name, COALESCE(a.custom_name, a.name) AS display_name,
               a.official_name, a.type, a.subtype, a.mask,
               a.current_balance, a.available_balance, a.owner,
               a.last_statement_balance, a.minimum_payment_amount,
               a.next_payment_due_date, a.is_overdue,
               i.institution_name
        FROM accounts a
        JOIN items i ON a.item_id = i.id
        JOIN account_members am ON am.account_id = a.id AND am.member_id = $1
        ORDER BY a.owner NULLS LAST, i.institution_name, a.name
      `, [member.id]);
      rows = result.rows;
    } else {
      // Parent view: include kid owner from account_members when a.owner is null
      const result = await pool.query(`
        SELECT a.id, a.name, a.custom_name, COALESCE(a.custom_name, a.name) AS display_name,
               a.official_name, a.type, a.subtype, a.mask,
               a.current_balance, a.available_balance,
               COALESCE(a.owner, fm.name) AS owner,
               a.last_statement_balance, a.minimum_payment_amount,
               a.next_payment_due_date, a.is_overdue,
               i.institution_name
        FROM accounts a
        JOIN items i ON a.item_id = i.id
        LEFT JOIN account_members am ON am.account_id = a.id
        LEFT JOIN family_members fm ON am.member_id = fm.id
        ORDER BY owner NULLS LAST, i.institution_name, a.name
      `);
      rows = result.rows;
    }

    assertNoSecrets(rows);

    let filtered = rows;

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

// ── PATCH /api/accounts/:id/name ─────────────────────────

router.patch('/api/accounts/:id/name', requireParent, async (req, res) => {
  try {
    const { custom_name } = req.body;
    const name = custom_name && custom_name.trim() ? custom_name.trim() : null;
    const { rows } = await pool.query(
      `UPDATE accounts SET custom_name = $1 WHERE id = $2
       RETURNING id, name, custom_name, COALESCE(custom_name, name) AS display_name`,
      [name, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/family-members ──────────────────────────────────

router.get('/api/family-members', async (req, res) => {
  try {
    if (req.member && req.member.role !== 'parent') {
      return res.status(403).json({ error: 'Parent access required' });
    }
    const { rows } = await pool.query(
      'SELECT id, name, role, avatar_emoji, color, monthly_budget FROM family_members ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
