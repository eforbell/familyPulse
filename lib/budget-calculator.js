'use strict';

const { pool } = require('./db');

/**
 * Get full budget summary for a given period (YYYY-MM).
 * Returns category cards, income, spending totals, net cash flow, uncategorized.
 */
async function getMonthlyBudgetSummary(period) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const startDate = `${period}-01`;
  const [year, month] = period.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  // Prior month for comparison
  const priorMonth = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
  const priorStart = `${priorMonth}-01`;

  // ── Category spending for current period ──────────────────
  const { rows: categorySpending } = await pool.query(`
    SELECT
      c.id, c.name, c.icon, c.color, c.budget_amount,
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount > 0
          AND t.is_transfer = false
          AND t.date >= $1::date AND t.date < $2::date
      )), 0)::numeric AS spent
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
    ORDER BY c.name
  `, [startDate, nextMonth]);

  // ── Rolling 3-month average ───────────────────────────────
  // Get up to 3 complete months before current period
  const threeMonthsAgo = getMonthsAgo(period, 3);
  const { rows: rollingAvg } = await pool.query(`
    SELECT
      c.id AS category_id,
      COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)), 0)::numeric AS total_spent,
      COUNT(DISTINCT to_char(t.date, 'YYYY-MM')) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)::int AS months_with_data
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
      AND t.date >= $1::date AND t.date < $2::date
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
  `, [threeMonthsAgo, startDate]);

  const avgMap = {};
  for (const r of rollingAvg) {
    const months = Math.min(r.months_with_data, 3) || 1;
    avgMap[r.category_id] = parseFloat(r.total_spent) / months;
  }

  // ── Build category cards ──────────────────────────────────
  const cards = categorySpending.map(c => {
    const budgeted = parseFloat(c.budget_amount) || 0;
    const spent = parseFloat(c.spent);
    const remaining = budgeted - spent;
    const pctUsed = budgeted > 0 ? (spent / budgeted) * 100 : 0;
    const status = pctUsed >= 100 ? 'red' : pctUsed >= 70 ? 'yellow' : 'green';
    const avg3mo = avgMap[c.id] || 0;

    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      budgeted,
      spent,
      remaining,
      pct_used: Math.round(pctUsed),
      status,
      avg_3mo: Math.round(avg3mo * 100) / 100
    };
  });

  // Sort: over-budget first (red, then yellow, then green), then by name
  const statusOrder = { red: 0, yellow: 1, green: 2 };
  cards.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));

  // ── Income ────────────────────────────────────────────────
  const { rows: [incomeRow] } = await pool.query(`
    SELECT
      COALESCE(ABS(SUM(amount) FILTER (
        WHERE date >= $1::date AND date < $2::date
      )), 0)::numeric AS current_income,
      COALESCE(ABS(SUM(amount) FILTER (
        WHERE date >= $3::date AND date < $1::date
      )), 0)::numeric AS prior_income
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE c.is_income = true AND t.is_transfer = false
  `, [startDate, nextMonth, priorStart]);

  // ── Spending totals ───────────────────────────────────────
  const totalSpent = cards.reduce((sum, c) => sum + c.spent, 0);
  const totalBudgeted = cards.reduce((sum, c) => sum + c.budgeted, 0);

  // ── Prior month spending for comparison ───────────────────
  const { rows: [priorSpendRow] } = await pool.query(`
    SELECT COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount > 0)), 0)::numeric AS prior_spent
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND t.is_transfer = false
      AND t.date >= $1::date AND t.date < $2::date
  `, [priorStart, startDate]);

  // ── Uncategorized ─────────────────────────────────────────
  const { rows: [uncatRow] } = await pool.query(`
    SELECT
      COALESCE(ABS(SUM(amount) FILTER (WHERE amount > 0)), 0)::numeric AS spent,
      COUNT(*) FILTER (WHERE amount > 0)::int AS count
    FROM transactions
    WHERE (category_id IS NULL OR category_id = (SELECT id FROM categories WHERE name = 'Uncategorized'))
      AND is_transfer = false
      AND date >= $1::date AND date < $2::date
  `, [startDate, nextMonth]);

  const currentIncome = parseFloat(incomeRow.current_income);
  const priorIncome = parseFloat(incomeRow.prior_income);
  const priorSpent = parseFloat(priorSpendRow.prior_spent);

  return {
    period,
    categories: cards,
    income: {
      current: currentIncome,
      prior: priorIncome
    },
    spending: {
      actual: Math.round(totalSpent * 100) / 100,
      budgeted: Math.round(totalBudgeted * 100) / 100
    },
    net_cash_flow: {
      current: Math.round((currentIncome - totalSpent) * 100) / 100,
      prior: Math.round((priorIncome - priorSpent) * 100) / 100
    },
    uncategorized: {
      spent: parseFloat(uncatRow.spent),
      count: uncatRow.count
    }
  };
}

/**
 * Get transactions for a specific category in a period.
 */
async function getCategoryDetail(categoryId, period) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const startDate = `${period}-01`;
  const [year, month] = period.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const { rows: category } = await pool.query(
    'SELECT id, name, icon, color, budget_amount FROM categories WHERE id = $1',
    [categoryId]
  );

  if (category.length === 0) return null;

  const { rows: transactions } = await pool.query(`
    SELECT t.id, t.merchant_name, t.name, t.amount, t.date, t.pending,
           a.name AS account_name, a.mask AS account_mask
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.category_id = $1
      AND t.is_transfer = false
      AND t.amount > 0
      AND t.date >= $2::date AND t.date < $3::date
    ORDER BY t.date DESC
  `, [categoryId, startDate, nextMonth]);

  return {
    ...category[0],
    period,
    transactions
  };
}

/**
 * Get the YYYY-MM string for N months before a given period.
 */
function getMonthsAgo(period, n) {
  const [year, month] = period.split('-').map(Number);
  const d = new Date(year, month - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

module.exports = { getMonthlyBudgetSummary, getCategoryDetail, getMonthsAgo };
