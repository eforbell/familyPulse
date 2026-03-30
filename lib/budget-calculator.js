'use strict';

const { pool } = require('./db');
const { getRecurringSummary } = require('./recurring-detector');

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
          AND t.is_hidden = false
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
      AND t.is_hidden = false
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
      AND t.is_hidden = false
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
      AND t.is_hidden = false
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
      AND is_hidden = false
      AND date >= $1::date AND date < $2::date
  `, [startDate, nextMonth]);

  const currentIncome = parseFloat(incomeRow.current_income);
  const priorIncome = parseFloat(incomeRow.prior_income);
  const priorSpent = parseFloat(priorSpendRow.prior_spent);
  let recurringSummary = {
    committed_monthly_total: 0,
    recurring_income_monthly_total: 0,
    active_count: 0,
    price_increase_count: 0,
    stale_count: 0
  };

  try {
    recurringSummary = await getRecurringSummary();
  } catch {
    // Recurring tables may not exist until migration 014 is applied.
  }

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
    committed_total: recurringSummary.committed_monthly_total,
    discretionary_total: Math.round((totalBudgeted - recurringSummary.committed_monthly_total) * 100) / 100,
    recurring_income_total: recurringSummary.recurring_income_monthly_total,
    recurring_count: recurringSummary.active_count,
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
    'SELECT id, name, icon, color, budget_amount, exclude_from_baseline FROM categories WHERE id = $1',
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
      AND t.is_hidden = false
      AND t.amount > 0
      AND t.date >= $2::date AND t.date < $3::date
    ORDER BY t.date DESC
  `, [categoryId, startDate, nextMonth]);

  let recurringForecast = {
    recurring_count: 0,
    recurring_monthly_total: 0
  };

  try {
    const { rows: [recurringRow] } = await pool.query(`
      SELECT
        COUNT(DISTINCT re.id)::int AS recurring_count,
        COALESCE(SUM(
          CASE re.frequency
            WHEN 'weekly' THEN re.latest_amount * 52.0 / 12.0
            WHEN 'biweekly' THEN re.latest_amount * 26.0 / 12.0
            WHEN 'semimonthly' THEN re.latest_amount * 2.0
            WHEN 'monthly' THEN re.latest_amount
            WHEN 'quarterly' THEN re.latest_amount / 3.0
            WHEN 'annual' THEN re.latest_amount / 12.0
            ELSE 0
          END
        ), 0)::numeric AS recurring_monthly_total
      FROM recurring_expenses re
      WHERE re.cashflow_type = 'expense'
        AND re.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM recurring_expense_history reh
          JOIN transactions t ON t.id = reh.transaction_id
          WHERE reh.recurring_expense_id = re.id
            AND t.category_id = $1
        )
    `, [categoryId]);

    recurringForecast = {
      recurring_count: recurringRow?.recurring_count || 0,
      recurring_monthly_total: Math.round((parseFloat(recurringRow?.recurring_monthly_total) || 0) * 100) / 100
    };
  } catch {
    // Recurring tables may not exist yet in early environments.
  }

  const categoryData = category[0];
  const includeInDiscretionaryBaseline = !categoryData.exclude_from_baseline;
  const recurringCount = recurringForecast.recurring_count;
  const recurringMonthlyTotal = recurringForecast.recurring_monthly_total;
  let forecastExplanation = includeInDiscretionaryBaseline
    ? 'This category stays in the forecast discretionary baseline, which means Pulse uses its past non-recurring spending to estimate future day-to-day spending.'
    : 'This category is excluded from the forecast discretionary baseline, so Pulse does not use its past spending here to estimate future day-to-day spending.';

  if (recurringCount > 0) {
    forecastExplanation += ` ${recurringCount} recurring item${recurringCount === 1 ? '' : 's'} tied to this category are forecast separately.`;
  } else {
    forecastExplanation += ' Recurring bills are forecast separately when Pulse detects a repeating merchant pattern.';
  }

  return {
    ...categoryData,
    period,
    transactions,
    forecast: {
      include_in_discretionary_baseline: includeInDiscretionaryBaseline,
      recurring_count: recurringCount,
      recurring_monthly_total: recurringMonthlyTotal,
      explanation: forecastExplanation
    }
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

/**
 * Get multi-month trend data for charts.
 * Returns per-month income, spending, net cash flow, and category breakdown.
 */
async function getBudgetTrends(months = 6) {
  months = Math.max(1, Math.min(months, 12));

  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Build period list (oldest first)
  const periods = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  // Ensure snapshots exist for all requested periods
  const { generateSnapshot } = require('./snapshot-generator');
  const { rows: existingSnaps } = await pool.query(
    'SELECT DISTINCT period FROM budget_snapshots WHERE period = ANY($1)',
    [periods]
  );
  const existingPeriods = new Set(existingSnaps.map(r => r.period));
  for (const p of periods) {
    if (!existingPeriods.has(p)) {
      await generateSnapshot(p);
    }
  }
  // Always refresh current month so data is live
  await generateSnapshot(currentPeriod);

  // Date range for income query
  const rangeStart = `${periods[0]}-01`;
  const lastPeriod = periods[periods.length - 1];
  const [ly, lm] = lastPeriod.split('-').map(Number);
  const rangeEnd = lm === 12 ? `${ly + 1}-01-01` : `${ly}-${String(lm + 1).padStart(2, '0')}-01`;

  // ── Snapshot data (category spending per month) ─────────
  const { rows: snapRows } = await pool.query(`
    SELECT bs.period, bs.category_id, c.name, c.color, c.icon,
           bs.actual_spent::numeric AS spent
    FROM budget_snapshots bs
    JOIN categories c ON bs.category_id = c.id
    WHERE bs.period = ANY($1)
      AND c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    ORDER BY bs.period, c.name
  `, [periods]);

  // ── Income per month ────────────────────────────────────
  const { rows: incomeRows } = await pool.query(`
    SELECT to_char(t.date, 'YYYY-MM') AS period,
           COALESCE(ABS(SUM(t.amount)), 0)::numeric AS income
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE c.is_income = true AND t.is_transfer = false AND t.is_hidden = false
      AND t.date >= $1::date AND t.date < $2::date
    GROUP BY to_char(t.date, 'YYYY-MM')
  `, [rangeStart, rangeEnd]);

  const incomeMap = {};
  for (const r of incomeRows) {
    incomeMap[r.period] = parseFloat(r.income);
  }

  // ── Assemble per-month results ──────────────────────────
  const monthly = periods.map(period => {
    const cats = snapRows
      .filter(r => r.period === period)
      .map(r => ({
        id: r.category_id,
        name: r.name,
        color: r.color,
        icon: r.icon,
        spent: Math.round(parseFloat(r.spent) * 100) / 100
      }));

    const spending = cats.reduce((sum, c) => sum + c.spent, 0);
    const income = incomeMap[period] || 0;

    return {
      period,
      income: Math.round(income * 100) / 100,
      spending: Math.round(spending * 100) / 100,
      net_cash_flow: Math.round((income - spending) * 100) / 100,
      categories: cats
    };
  });

  return { periods, monthly };
}

module.exports = { getMonthlyBudgetSummary, getCategoryDetail, getMonthsAgo, getBudgetTrends };
