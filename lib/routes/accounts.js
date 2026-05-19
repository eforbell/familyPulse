'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { assertNoSecrets } = require('../secrets-guard');
const { getCoverage } = require('../coverage-calculator');
const { requireParent } = require('../auth');
const {
  VALID_BALANCE_BASES,
  getConfiguredBalanceBasis,
  getDepositoryBalanceLabel,
  getAccountBalanceMeta
} = require('../balance-policy');

const router = Router();

function withDisplayBalance(account, balanceBasis) {
  const balance = getAccountBalanceMeta(account, balanceBasis);
  return {
    ...account,
    display_balance: balance.amount,
    display_balance_kind: balance.kind,
    display_balance_label: balance.label,
    ledger_balance: balance.ledger_amount
  };
}

function getDashboardSortBucket(account) {
  if (account.type === 'depository' || account.type === 'investment') return 0; // cash/assets
  if (account.type === 'credit' || account.type === 'loan') return 1; // liabilities
  return 2;
}

function getDashboardSortBalance(account) {
  const bucket = getDashboardSortBucket(account);
  if (bucket === 1) return parseFloat(account.current_balance) || 0;
  return parseFloat(account.display_balance) || 0;
}

function sortDashboardAccounts(accounts) {
  accounts.sort((a, b) => {
    const bucketDiff = getDashboardSortBucket(a) - getDashboardSortBucket(b);
    if (bucketDiff !== 0) return bucketDiff;

    const balanceDiff = getDashboardSortBalance(b) - getDashboardSortBalance(a);
    if (balanceDiff !== 0) return balanceDiff;

    const institutionCompare = (a.institution_name || '').localeCompare(b.institution_name || '');
    if (institutionCompare !== 0) return institutionCompare;

    return (a.display_name || a.name || '').localeCompare(b.display_name || b.name || '');
  });
}

// ── GET /api/accounts/coverage ────────────────────────────────

router.get('/api/accounts/coverage', requireParent, async (req, res) => {
  try {
    const coverage = await getCoverage({
      balanceBasis: await getConfiguredBalanceBasis(req.app.get('cfg'))
    });
    res.json(coverage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET/PUT /api/settings/balance-basis ───────────────────────

router.get('/api/settings/balance-basis', requireParent, async (req, res) => {
  try {
    const balanceBasis = await getConfiguredBalanceBasis(req.app.get('cfg'));
    res.json({
      balance_basis: balanceBasis,
      depository_balance_label: getDepositoryBalanceLabel(balanceBasis)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/settings/balance-basis', requireParent, async (req, res) => {
  try {
    const { balance_basis: balanceBasis } = req.body || {};
    if (!VALID_BALANCE_BASES.has(balanceBasis)) {
      return res.status(400).json({ error: 'balance_basis must be available_preferred or current_only' });
    }

    const setCfg = req.app.get('setCfg');
    await setCfg('balance_basis', balanceBasis);
    res.json({
      ok: true,
      balance_basis: balanceBasis,
      depository_balance_label: getDepositoryBalanceLabel(balanceBasis)
    });
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
             a.sync_status, a.sync_disabled_at,
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
    const balanceBasis = await getConfiguredBalanceBasis(req.app.get('cfg'));
    const member = req.member; // from session middleware
    const isKid = member && member.role === 'kid';

    let rows;
    if (isKid) {
      // Kids only see their linked accounts (via account_members table)
      const result = await pool.query(`
        SELECT a.id, a.name, a.custom_name, COALESCE(a.custom_name, a.name) AS display_name,
               a.official_name, a.type, a.subtype, a.mask,
               a.current_balance, a.available_balance, a.owner,
               a.sync_status, a.sync_disabled_at,
               a.last_statement_balance, a.last_statement_issue_date,
               a.minimum_payment_amount, a.next_payment_due_date,
               a.last_payment_amount, a.last_payment_date, a.is_overdue,
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
               a.sync_status, a.sync_disabled_at,
               a.last_statement_balance, a.last_statement_issue_date,
               a.minimum_payment_amount, a.next_payment_due_date,
               a.last_payment_amount, a.last_payment_date, a.is_overdue,
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

    const filtered = rows.map(account => withDisplayBalance(account, balanceBasis));
    const activeAccounts = filtered.filter(account => account.sync_status !== 'historical');
    const historicalAccounts = filtered.filter(account => account.sync_status === 'historical');

    // Group by owner, keeping historical accounts visible but separate from live totals.
    const groups = {};
    const historicalGroups = {};
    let liquidTotal = 0;
    let creditTotal = 0;

    for (const acct of activeAccounts) {
      const owner = acct.owner || 'Household';
      if (!groups[owner]) groups[owner] = [];
      groups[owner].push(acct);

      const displayBalance = parseFloat(acct.display_balance) || 0;
      const currentBalance = parseFloat(acct.current_balance) || 0;
      if (acct.type === 'depository' || acct.type === 'investment') {
        liquidTotal += displayBalance;
      } else if (acct.type === 'credit') {
        creditTotal += currentBalance;
      }
    }

    for (const acct of historicalAccounts) {
      const owner = acct.owner || 'Household';
      if (!historicalGroups[owner]) historicalGroups[owner] = [];
      historicalGroups[owner].push(acct);
    }

    for (const ownerAccounts of Object.values(groups)) {
      sortDashboardAccounts(ownerAccounts);
    }

    for (const ownerAccounts of Object.values(historicalGroups)) {
      sortDashboardAccounts(ownerAccounts);
    }

    res.json({
      balance_basis: balanceBasis,
      depository_balance_label: getDepositoryBalanceLabel(balanceBasis),
      groups,
      historical_groups: historicalGroups,
      liquid_total: Math.round(liquidTotal * 100) / 100,
      credit_total: Math.round(creditTotal * 100) / 100,
      net_position: Math.round((liquidTotal - creditTotal) * 100) / 100,
      account_count: activeAccounts.length,
      historical_account_count: historicalAccounts.length
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
