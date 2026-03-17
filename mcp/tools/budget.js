'use strict';

const { getMonthlyBudgetSummary } = require('../../lib/budget-calculator');

/**
 * get_budget_status — current month budget vs. actual by category.
 */
async function getBudgetStatus({ period } = {}) {
  const summary = await getMonthlyBudgetSummary(period || undefined);

  return {
    period: summary.period,
    income: summary.income.current,
    prior_income: summary.income.prior,
    spending: summary.spending.actual,
    budgeted: summary.spending.budgeted,
    net_cash_flow: summary.net_cash_flow.current,
    prior_net_cash_flow: summary.net_cash_flow.prior,
    categories: summary.categories.map(c => ({
      name: c.name,
      budgeted: c.budgeted,
      spent: c.spent,
      remaining: c.remaining,
      pct_used: c.pct_used,
      status: c.status,
      avg_3mo: c.avg_3mo
    })),
    uncategorized: summary.uncategorized
  };
}

/**
 * get_cash_flow_summary — net cash flow for a period range.
 */
async function getCashFlowSummary({ start_period, end_period } = {}) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  if (!end_period) {
    end_period = `${year}-${String(month).padStart(2, '0')}`;
  }

  if (!start_period) {
    const startDate = new Date(year, month - 4, 1);
    start_period = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
  }

  // Build period list
  const periods = [];
  let [y, m] = start_period.split('-').map(Number);
  const [ey, em] = end_period.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && periods.length < 12) {
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  const months = [];
  let totalIncome = 0;
  let totalSpending = 0;

  for (const p of periods) {
    const s = await getMonthlyBudgetSummary(p);
    months.push({
      period: p,
      income: s.income.current,
      spending: s.spending.actual,
      net_cash_flow: s.net_cash_flow.current
    });
    totalIncome += s.income.current;
    totalSpending += s.spending.actual;
  }

  return {
    start_period,
    end_period,
    months,
    totals: {
      income: Math.round(totalIncome * 100) / 100,
      spending: Math.round(totalSpending * 100) / 100,
      net_cash_flow: Math.round((totalIncome - totalSpending) * 100) / 100
    },
    averages: {
      income: Math.round((totalIncome / months.length) * 100) / 100,
      spending: Math.round((totalSpending / months.length) * 100) / 100,
      net_cash_flow: Math.round(((totalIncome - totalSpending) / months.length) * 100) / 100
    }
  };
}

module.exports = { getBudgetStatus, getCashFlowSummary };
