'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { requireParent } = require('../auth');
const {
  getConfiguredBalanceBasis,
  getDepositoryBalanceLabel,
  getAccountBalanceMeta
} = require('../balance-policy');

const router = Router();

// ── GET /api/kids/dashboard ─────────────────────────────────
// Kid-only: returns scoped financial data for the logged-in kid.

router.get('/api/kids/dashboard', async (req, res) => {
  try {
    const balanceBasis = await getConfiguredBalanceBasis(req.app.get('cfg'));
    const member = req.member;
    if (!member || member.role !== 'kid') {
      return res.status(403).json({ error: 'Kid access required' });
    }

    const memberId = member.id;

    // Get member details including budget
    const { rows: [memberRow] } = await pool.query(
      'SELECT name, avatar_emoji, monthly_budget FROM family_members WHERE id = $1',
      [memberId]
    );

    // Get linked accounts
    const { rows: accounts } = await pool.query(`
      SELECT a.id, a.name, a.custom_name, COALESCE(a.custom_name, a.name) AS display_name,
             a.type, a.subtype, a.mask, a.current_balance, a.available_balance,
             a.sync_status, a.sync_disabled_at,
             i.institution_name
      FROM accounts a
      JOIN items i ON a.item_id = i.id
      JOIN account_members am ON am.account_id = a.id AND am.member_id = $1
      ORDER BY i.institution_name, a.name
    `, [memberId]);

    const activeAccounts = accounts.filter(account => account.sync_status !== 'historical');
    const historicalAccounts = accounts.filter(account => account.sync_status === 'historical');

    const scopedAccounts = activeAccounts.map(account => {
      const balance = getAccountBalanceMeta(account, balanceBasis);
      return {
        ...account,
        display_balance: balance.amount,
        display_balance_kind: balance.kind,
        display_balance_label: balance.label,
        ledger_balance: balance.ledger_amount
      };
    });

    const accountIds = scopedAccounts.map(a => a.id);
    const balanceTotal = scopedAccounts.reduce(
      (sum, a) => sum + (parseFloat(a.display_balance) || 0), 0
    );

    // Current month date range
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startDate = `${period}-01`;
    const [year, month] = period.split('-').map(Number);
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    // Month spending total (non-transfer, non-hidden, debits only)
    let monthSpending = 0;
    if (accountIds.length > 0) {
      const { rows: [spendRow] } = await pool.query(`
        SELECT COALESCE(ABS(SUM(amount) FILTER (WHERE amount > 0)), 0)::numeric AS total
        FROM transactions
        WHERE account_id = ANY($1::int[])
          AND is_transfer = false
          AND is_hidden = false
          AND date >= $2::date AND date < $3::date
      `, [accountIds, startDate, nextMonth]);
      monthSpending = parseFloat(spendRow.total);
    }

    // Budget calculation
    const monthlyBudget = memberRow.monthly_budget ? parseFloat(memberRow.monthly_budget) : null;
    let budget = null;
    if (monthlyBudget !== null) {
      const remaining = monthlyBudget - monthSpending;
      const pctUsed = monthlyBudget > 0 ? Math.round((monthSpending / monthlyBudget) * 100) : 0;
      budget = { amount: monthlyBudget, spent: monthSpending, remaining, pct_used: pctUsed };
    }

    // Recent transactions (last 30 days, limit 20)
    let recentTransactions = [];
    if (accountIds.length > 0) {
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { rows } = await pool.query(`
        SELECT t.id, t.amount, t.date, t.merchant_name, t.name, t.pending,
               t.category_id, t.is_transfer, t.transfer_type,
               COALESCE(a.custom_name, a.name) AS account_name,
               c.name AS category_name, c.color AS category_color, c.icon AS category_icon
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.account_id = ANY($1::int[])
          AND t.is_transfer = false
          AND t.is_hidden = false
          AND t.date >= $2::date
        ORDER BY t.date DESC, t.id DESC
        LIMIT 20
      `, [accountIds, thirtyDaysAgo.toISOString().slice(0, 10)]);
      recentTransactions = rows;
    }

    // Category breakdown (current month)
    let categoryBreakdown = [];
    if (accountIds.length > 0) {
      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.icon, c.color,
               COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount > 0)), 0)::numeric AS spent
        FROM categories c
        JOIN transactions t ON t.category_id = c.id
        WHERE t.account_id = ANY($1::int[])
          AND t.is_transfer = false
          AND t.is_hidden = false
          AND t.date >= $2::date AND t.date < $3::date
          AND t.amount > 0
        GROUP BY c.id
        HAVING SUM(t.amount) > 0
        ORDER BY spent DESC
      `, [accountIds, startDate, nextMonth]);
      categoryBreakdown = rows.map(r => ({ ...r, spent: parseFloat(r.spent) }));
    }

    res.json({
      balance_basis: balanceBasis,
      depository_balance_label: getDepositoryBalanceLabel(balanceBasis),
      member: { name: memberRow.name, emoji: memberRow.avatar_emoji, monthly_budget: monthlyBudget },
      accounts: scopedAccounts,
      historical_accounts: historicalAccounts.map(account => ({
        ...account,
        current_balance: parseFloat(account.current_balance),
        available_balance: account.available_balance == null ? null : parseFloat(account.available_balance)
      })),
      balance_total: Math.round(balanceTotal * 100) / 100,
      account_count: scopedAccounts.length,
      historical_account_count: historicalAccounts.length,
      month_spending: Math.round(monthSpending * 100) / 100,
      budget,
      recent_transactions: recentTransactions,
      category_breakdown: categoryBreakdown,
      period
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/kids/report-card ───────────────────────────────
// Kid-only: returns LLM-generated money report card.

router.get('/api/kids/report-card', async (req, res) => {
  try {
    const member = req.member;
    if (!member || member.role !== 'kid') {
      return res.status(403).json({ error: 'Kid access required' });
    }

    const period = req.query.period || null;
    const { generateKidReportCard } = require('../magic-actions/kid-report-card');
    const cfg = req.app.get('cfg');
    const result = await generateKidReportCard(member.id, period, cfg);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/kids/budget ────────────────────────────────────
// Parent-only: set a kid's monthly budget.

router.put('/api/kids/budget', requireParent, async (req, res) => {
  try {
    const { member_id, amount } = req.body;
    if (!member_id) {
      return res.status(400).json({ error: 'member_id is required' });
    }

    // Verify target is a kid
    const { rows: [target] } = await pool.query(
      'SELECT id, role FROM family_members WHERE id = $1',
      [member_id]
    );
    if (!target) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (target.role !== 'kid') {
      return res.status(400).json({ error: 'Budget can only be set for kid-role members' });
    }

    const budgetAmount = amount === null || amount === undefined ? null : parseFloat(amount);

    await pool.query(
      'UPDATE family_members SET monthly_budget = $1 WHERE id = $2',
      [budgetAmount, member_id]
    );

    res.json({ success: true, member_id, monthly_budget: budgetAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
