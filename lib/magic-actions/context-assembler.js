'use strict';

const { pool } = require('../db');
const { getMonthlyBudgetSummary, getMonthsAgo } = require('../budget-calculator');
const { getCoverage } = require('../coverage-calculator');
const { getRecurringSummary } = require('../recurring-detector');
const { sanitizeForLLM } = require('../secrets-guard');
const { getCachedForecast } = require('../forecast-service');

/**
 * Assemble weekly context: budget summary + anomalies for a period.
 * Refactored from digest-generator.js.
 */
async function assembleWeeklyContext(period) {
  if (!period) period = currentPeriod();

  const budgetSummary = await getMonthlyBudgetSummary(period);

  const { rows: anomalies } = await pool.query(`
    SELECT a.anomaly_type, a.current_amount, a.avg_3mo, a.avg_12mo, a.pct_of_3mo, a.pct_of_12mo,
           c.name AS category_name
    FROM anomalies a
    JOIN categories c ON a.category_id = c.id
    WHERE a.period = $1
    ORDER BY a.current_amount DESC
  `, [period]);

  const coverage = await getCoverageSummary();
  const recurring = await getRecurringContextSummary();
  const forecast = await getForecastContextSummary();

  return sanitizeForLLM({
    period,
    income: budgetSummary.income.current,
    total_spending: budgetSummary.spending.actual,
    total_budgeted: budgetSummary.spending.budgeted,
    net_cash_flow: budgetSummary.net_cash_flow.current,
    categories: budgetSummary.categories.map(c => ({
      name: c.name,
      spent: c.spent,
      budgeted: c.budgeted,
      pct_used: c.pct_used,
      avg_3mo: c.avg_3mo
    })),
    anomalies: anomalies.map(a => ({
      category: a.category_name,
      type: a.anomaly_type,
      current: parseFloat(a.current_amount),
      avg_3mo: parseFloat(a.avg_3mo),
      avg_12mo: parseFloat(a.avg_12mo),
      pct_of_3mo: parseFloat(a.pct_of_3mo),
      pct_of_12mo: parseFloat(a.pct_of_12mo)
    })),
    recurring,
    liability_coverage: coverage,
    forecast,
    family: await getFamilyNames()
  });
}

/**
 * Assemble monthly context: budget summary + prior month comparison +
 * category breakdown + uncategorized count.
 */
async function assembleMonthlyContext(period) {
  if (!period) period = currentPeriod();

  const budgetSummary = await getMonthlyBudgetSummary(period);

  // Prior month for comparison
  const [year, month] = period.split('-').map(Number);
  const priorPeriod = month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
  const priorSummary = await getMonthlyBudgetSummary(priorPeriod);

  // 3-month rolling averages for income/spending
  const threeMonthStart = getMonthsAgo(period, 3);
  const startDate = `${period}-01`;
  const { rows: [rollingRow] } = await pool.query(`
    SELECT
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount < 0 AND c.is_income = true AND t.is_transfer = false AND t.is_hidden = false
      )), 0)::numeric AS total_income,
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount > 0 AND c.is_transfer_class = false AND c.is_income = false
          AND t.is_transfer = false AND t.is_hidden = false
      )), 0)::numeric AS total_spending
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE t.date >= $1::date AND t.date < $2::date
  `, [threeMonthStart, startDate]);

  const avg3moIncome = parseFloat(rollingRow.total_income) / 3;
  const avg3moSpending = parseFloat(rollingRow.total_spending) / 3;

  // Wins and overruns
  const wins = budgetSummary.categories
    .filter(c => c.budgeted > 0 && c.spent <= c.budgeted)
    .map(c => ({ name: c.name, spent: c.spent, budgeted: c.budgeted, saved: c.budgeted - c.spent }))
    .sort((a, b) => b.saved - a.saved)
    .slice(0, 5);

  const overruns = budgetSummary.categories
    .filter(c => c.budgeted > 0 && c.spent > c.budgeted)
    .map(c => ({ name: c.name, spent: c.spent, budgeted: c.budgeted, over: c.spent - c.budgeted }))
    .sort((a, b) => b.over - a.over);

  const coverage = await getCoverageSummary();
  const recurring = await getRecurringContextSummary();
  const forecast = await getForecastContextSummary();

  return sanitizeForLLM({
    period,
    income: budgetSummary.income.current,
    prior_income: priorSummary.income.current,
    avg_3mo_income: Math.round(avg3moIncome * 100) / 100,
    total_spending: budgetSummary.spending.actual,
    total_budgeted: budgetSummary.spending.budgeted,
    prior_spending: priorSummary.spending.actual,
    avg_3mo_spending: Math.round(avg3moSpending * 100) / 100,
    net_cash_flow: budgetSummary.net_cash_flow.current,
    prior_net_cash_flow: priorSummary.net_cash_flow.current,
    categories: budgetSummary.categories.map(c => ({
      name: c.name,
      spent: c.spent,
      budgeted: c.budgeted,
      pct_used: c.pct_used,
      avg_3mo: c.avg_3mo
    })),
    wins,
    overruns,
    uncategorized_count: budgetSummary.uncategorized.count,
    uncategorized_amount: budgetSummary.uncategorized.spent,
    recurring,
    liability_coverage: coverage,
    forecast,
    family: await getFamilyNames()
  });
}

/**
 * Assemble query context driven by a parsed intent.
 * @param {object} intent - { start_period, end_period, focus }
 *   focus: "budget" | "merchants" | "accounts" | "general"
 */
async function assembleQueryContext(intent) {
  const { start_period, end_period, focus } = intent;

  // Build list of periods to cover
  const periods = listPeriods(start_period, end_period);
  const context = { periods_covered: `${start_period} to ${end_period}`, family: await getFamilyNames() };
  context.recurring = await getRecurringContextSummary();
  context.forecast = await getForecastContextSummary();

  // ── Budget / category data per period ────────────────────
  if (focus !== 'accounts') {
    const periodSummaries = [];
    for (const p of periods) {
      const s = await getMonthlyBudgetSummary(p);
      periodSummaries.push({
        period: p,
        income: s.income.current,
        spending: s.spending.actual,
        budgeted: s.spending.budgeted,
        net_cash_flow: s.net_cash_flow.current,
        categories: s.categories.map(c => ({
          name: c.name, spent: c.spent, budgeted: c.budgeted, pct_used: c.pct_used
        })),
        uncategorized_count: s.uncategorized.count
      });
    }
    context.months = periodSummaries;
  }

  // ── Account balances (current snapshot) ──────────────────
  if (focus === 'accounts' || focus === 'general') {
    const { rows: accts } = await pool.query(`
      SELECT a.name, a.type, a.subtype, a.current_balance,
             a.last_statement_balance, a.next_payment_due_date
      FROM accounts a JOIN items i ON a.item_id = i.id
      WHERE i.status = 'good' ORDER BY a.type, a.name
    `);
    context.accounts = accts.map(a => {
      const obj = {
        name: a.name, type: a.type, subtype: a.subtype,
        balance: parseFloat(a.current_balance)
      };
      if (a.type === 'credit') {
        if (a.last_statement_balance != null) obj.statement_balance = parseFloat(a.last_statement_balance);
        if (a.next_payment_due_date) obj.due_date = a.next_payment_due_date;
      }
      return obj;
    });

    const coverage = await getCoverageSummary();
    context.liability_coverage = coverage;
  }

  // ── Top merchants across the date range ──────────────────
  if (focus === 'merchants' || focus === 'general') {
    const rangeStart = `${start_period}-01`;
    const [ey, em] = end_period.split('-').map(Number);
    const rangeEnd = em === 12 ? `${ey + 1}-01-01` : `${ey}-${String(em + 1).padStart(2, '0')}-01`;

    const { rows: merchants } = await pool.query(`
      SELECT COALESCE(merchant_name, name) AS merchant,
             COUNT(*)::int AS count,
             ABS(SUM(amount))::numeric AS total
      FROM transactions
      WHERE date >= $1::date AND date < $2::date
        AND is_transfer = false AND is_hidden = false AND amount > 0
      GROUP BY COALESCE(merchant_name, name)
      ORDER BY total DESC LIMIT 15
    `, [rangeStart, rangeEnd]);
    context.top_merchants = merchants.map(m => ({
      merchant: m.merchant, count: m.count, total: parseFloat(m.total)
    }));
  }

  return sanitizeForLLM(context);
}

/**
 * List YYYY-MM periods from start to end (inclusive), capped at 12.
 */
function listPeriods(start, end) {
  const periods = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && periods.length < 12) {
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return periods;
}

/**
 * Assemble financial snapshot: current balances, monthly income/expense averages (last 3mo),
 * savings rate — for what-if scenarios.
 */
async function assembleFinancialSnapshot() {
  // Account balances
  const { rows: accounts } = await pool.query(`
    SELECT a.name, a.type, a.subtype, a.current_balance,
           a.last_statement_balance, a.next_payment_due_date
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE i.status = 'good'
    ORDER BY a.type, a.name
  `);

  const liquidTotal = accounts
    .filter(a => a.type === 'depository')
    .reduce((s, a) => s + parseFloat(a.current_balance), 0);
  const creditTotal = accounts
    .filter(a => a.type === 'credit')
    .reduce((s, a) => s + parseFloat(a.current_balance), 0);
  const investmentTotal = accounts
    .filter(a => a.type === 'investment')
    .reduce((s, a) => s + parseFloat(a.current_balance), 0);

  // Last 3 months income/spending averages
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const threeMonthStart = getMonthsAgo(period, 3);
  const startDate = `${period}-01`;

  const { rows: [avgRow] } = await pool.query(`
    SELECT
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount < 0 AND c.is_income = true AND t.is_transfer = false AND t.is_hidden = false
      )), 0)::numeric AS total_income,
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount > 0 AND c.is_transfer_class = false AND c.is_income = false
          AND t.is_transfer = false AND t.is_hidden = false
      )), 0)::numeric AS total_spending
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE t.date >= $1::date AND t.date < $2::date
  `, [threeMonthStart, startDate]);

  const avgMonthlyIncome = parseFloat(avgRow.total_income) / 3;
  const avgMonthlySpending = parseFloat(avgRow.total_spending) / 3;
  const savingsRate = avgMonthlyIncome > 0
    ? Math.round(((avgMonthlyIncome - avgMonthlySpending) / avgMonthlyIncome) * 100)
    : 0;

  const coverage = await getCoverageSummary();
  const recurring = await getRecurringContextSummary();

  return sanitizeForLLM({
    liquid_balance: Math.round(liquidTotal * 100) / 100,
    credit_balance: Math.round(creditTotal * 100) / 100,
    investment_balance: Math.round(investmentTotal * 100) / 100,
    net_position: Math.round((liquidTotal + creditTotal + investmentTotal) * 100) / 100,
    statement_obligations: coverage ? coverage.obligation_total : 0,
    coverage_ratio: coverage ? coverage.ratio : null,
    avg_monthly_income: Math.round(avgMonthlyIncome * 100) / 100,
    avg_monthly_spending: Math.round(avgMonthlySpending * 100) / 100,
    avg_monthly_savings: Math.round((avgMonthlyIncome - avgMonthlySpending) * 100) / 100,
    savings_rate_pct: savingsRate,
    accounts: accounts.map(a => {
      const obj = {
        name: a.name,
        type: a.type,
        balance: parseFloat(a.current_balance)
      };
      if (a.type === 'credit') {
        if (a.last_statement_balance != null) obj.statement_balance = parseFloat(a.last_statement_balance);
        if (a.next_payment_due_date) obj.due_date = a.next_payment_due_date;
      }
      return obj;
    }),
    recurring,
    liability_coverage: coverage,
    forecast: await getForecastContextSummary(),
    family: await getFamilyNames()
  });
}

/**
 * Get a compact coverage summary for LLM context.
 */
async function getCoverageSummary() {
  try {
    const cov = await getCoverage();
    return {
      depository_total: cov.depository_total,
      obligation_total: cov.obligation_total,
      ratio: cov.ratio,
      status: cov.status,
      cards: cov.cards.map(c => ({
        name: c.name,
        obligation: c.obligation,
        due_date: c.due_date,
        is_overdue: c.is_overdue
      }))
    };
  } catch {
    return null;
  }
}

async function getRecurringContextSummary() {
  try {
    const summary = await getRecurringSummary();
    const { rows: topRows } = await pool.query(`
      SELECT merchant_name, cashflow_type, latest_amount, frequency, expected_next_date
      FROM recurring_expenses
      WHERE status = 'active'
      ORDER BY latest_amount DESC, merchant_name ASC
      LIMIT 5
    `);
    const { rows: priceIncreaseRows } = await pool.query(`
      SELECT merchant_name, price_change_pct, latest_amount
      FROM recurring_expenses
      WHERE price_change_direction = 'up'
      ORDER BY price_change_date DESC NULLS LAST, latest_amount DESC
      LIMIT 5
    `);
    const { rows: renewalRows } = await pool.query(`
      SELECT merchant_name, expected_next_date, latest_amount
      FROM recurring_expenses
      WHERE status = 'active'
        AND frequency = 'annual'
        AND expected_next_date IS NOT NULL
        AND expected_next_date >= current_date
        AND expected_next_date <= current_date + 60
      ORDER BY expected_next_date ASC
      LIMIT 5
    `);

    return {
      committed_monthly_total: summary.committed_monthly_total,
      recurring_income_monthly_total: summary.recurring_income_monthly_total,
      count_active: summary.active_count,
      stale_count: summary.stale_count,
      price_increase_count: summary.price_increase_count,
      top_recurring: topRows.map(row => ({
        merchant_name: row.merchant_name,
        cashflow_type: row.cashflow_type,
        latest_amount: parseFloat(row.latest_amount),
        frequency: row.frequency,
        expected_next_date: row.expected_next_date instanceof Date
          ? row.expected_next_date.toISOString().slice(0, 10)
          : row.expected_next_date
      })),
      price_increases: priceIncreaseRows.map(row => ({
        merchant_name: row.merchant_name,
        price_change_pct: parseFloat(row.price_change_pct),
        latest_amount: parseFloat(row.latest_amount)
      })),
      upcoming_annual_renewals: renewalRows.map(row => ({
        merchant_name: row.merchant_name,
        expected_next_date: row.expected_next_date instanceof Date
          ? row.expected_next_date.toISOString().slice(0, 10)
          : row.expected_next_date,
        latest_amount: parseFloat(row.latest_amount)
      }))
    };
  } catch {
    return {
      committed_monthly_total: 0,
      recurring_income_monthly_total: 0,
      count_active: 0,
      stale_count: 0,
      price_increase_count: 0,
      top_recurring: [],
      price_increases: [],
      upcoming_annual_renewals: []
    };
  }
}

/**
 * Get a compact forecast summary for LLM context.
 */
async function getForecastContextSummary() {
  try {
    const data = await getCachedForecast();
    if (!data || !data.projections || data.projections.length === 0) return null;

    const projections = data.projections;
    const dangerZones = data.danger_zones || [];
    const monthlyOutlook = data.monthly_outlook || [];
    const excess = data.excess_liquidity || {};
    const meta = data.meta || {};

    const nextDanger = dangerZones.find(z => z.severity === 'danger');
    const projected90d = projections[projections.length - 1];

    // Planned expenses and income totals from monthly outlook
    const plannedTotal = monthlyOutlook.reduce((s, m) => s + (m.planned_expenses_total || 0), 0);
    const plannedIncomeTotal = monthlyOutlook.reduce((s, m) => s + (m.planned_income_total || 0), 0);

    // Determine outlook status
    const nearDanger = dangerZones.filter(z => z.severity === 'danger');
    const nearRisk = dangerZones.filter(z => z.severity === 'at_risk');
    let outlookStatus = 'healthy';
    if (nearDanger.length > 0) outlookStatus = 'danger';
    else if (nearRisk.length > 0) outlookStatus = 'caution';

    return {
      '90_day_outlook_status': outlookStatus,
      current_liquid_balance: meta.starting_balance || 0,
      projected_90_day_balance: projected90d ? projected90d.projected_balance : null,
      next_danger_zone: nextDanger ? {
        date: nextDanger.date,
        projected_balance: nextDanger.projected_balance,
        deficit_below_floor: nextDanger.deficit_below_floor,
        trigger: nextDanger.trigger_event ? nextDanger.trigger_event.name : null
      } : null,
      monthly_outlook: monthlyOutlook.slice(0, 3).map(m => ({
        month: m.month,
        net_surplus_or_deficit: m.net_surplus_or_deficit,
        projected_end_balance: m.projected_end_balance,
        ...(m.planned_income_total > 0 && { planned_income_total: m.planned_income_total }),
        ...(m.planned_expenses_total > 0 && { planned_expenses_total: m.planned_expenses_total })
      })),
      planned_expenses_total: Math.round(plannedTotal * 100) / 100,
      ...(plannedIncomeTotal > 0 && { planned_income_total: Math.round(plannedIncomeTotal * 100) / 100 }),
      excess_liquidity_opportunity: excess.recommendation_level && excess.recommendation_level !== 'none'
        ? { excess_amount: excess.excess_amount, reserve_target: excess.reserve_target, level: excess.recommendation_level }
        : null
    };
  } catch {
    return null;
  }
}

async function getFamilyNames() {
  const { rows } = await pool.query('SELECT name FROM family_members ORDER BY id');
  return rows.map(r => r.name);
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  assembleWeeklyContext,
  assembleMonthlyContext,
  assembleQueryContext,
  assembleFinancialSnapshot,
  getRecurringContextSummary,
  getForecastContextSummary
};
