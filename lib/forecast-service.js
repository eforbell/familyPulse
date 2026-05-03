'use strict';

const { pool } = require('./db');
const { computeForecast, detectDangerZones, computeMonthlyOutlook, detectExcessLiquidity } = require('./cash-flow-engine');
const { computeSeasonalBaseline } = require('./seasonal-baseline');
const { sumAccountBalances, getConfiguredBalanceBasis } = require('./balance-policy');
const { monthlyEquivalent } = require('./recurring-detector');
const crypto = require('crypto');

/**
 * Compute a full forecast, cache it, and return the result.
 * All inputs are fetched from the database.
 *
 * @param {Function} cfg — app config reader (key => value)
 * @returns {Object} { projections, danger_zones, monthly_outlook, excess_liquidity, meta }
 */
async function computeAndCacheForecast(cfg) {
  const horizonDays = parseInt(await cfg('cash_flow_horizon_days') || '90', 10);
  const safetyFloor = parseFloat(await cfg('cash_flow_safety_floor') || '3000');
  const reserveTargetMonths = parseFloat(await cfg('cash_reserve_target_months') || '3.0');
  const reserveTargetAmount = await cfg('cash_reserve_target_amount');

  // 1. Starting balance from depository accounts
  const balanceBasis = await getConfiguredBalanceBasis(cfg);
  const { rows: accounts } = await pool.query(`
    SELECT a.* FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE i.status = 'good'
  `);
  const startingBalance = sumAccountBalances(
    accounts,
    balanceBasis,
    a => a.type === 'depository'
  );

  // 2. Recurring income & expenses from Feature 19
  const { rows: recurringRows } = await pool.query(`
    SELECT merchant_key, merchant_name, latest_amount, frequency,
           last_seen_date, expected_next_date,
           schedule_anchor_type, schedule_anchor_value,
           cashflow_type
    FROM recurring_expenses
    WHERE status = 'active'
      AND confidence IN ('medium', 'high')
      AND expected_next_date IS NOT NULL
  `);

  const recurringIncome = [];
  const recurringExpenses = [];
  // Track merchant keys used in recurring to avoid double-counting with liability payments
  const recurringMerchantKeys = new Set();

  for (const r of recurringRows) {
    const item = {
      merchant_key: r.merchant_key,
      name: r.merchant_name,
      amount: Math.abs(Number(r.latest_amount)),
      frequency: r.frequency,
      last_seen_date: formatDateStr(r.last_seen_date),
      expected_next_date: formatDateStr(r.expected_next_date),
      schedule_anchor_type: r.schedule_anchor_type,
      schedule_anchor_value: r.schedule_anchor_value
    };
    recurringMerchantKeys.add(r.merchant_key);
    if (r.cashflow_type === 'income') {
      recurringIncome.push(item);
    } else {
      recurringExpenses.push(item);
    }
  }

  // 3. Liability payments from Plaid data
  const { rows: liabilityRows } = await pool.query(`
    SELECT a.name AS account_name, a.minimum_payment_amount, a.next_payment_due_date
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE i.status = 'good'
      AND a.type = 'loan'
      AND a.minimum_payment_amount IS NOT NULL
      AND a.minimum_payment_amount > 0
      AND a.next_payment_due_date IS NOT NULL
  `);
  const liabilityPayments = liabilityRows.map(r => ({
    account_name: r.account_name,
    minimum_payment_amount: Number(r.minimum_payment_amount),
    next_payment_due_date: formatDateStr(r.next_payment_due_date)
  }));

  // 4. Seasonal baseline
  const seasonalBaseline = await computeSeasonalBaseline();

  // 5. Planned expenses and income
  const { rows: plannedRows } = await pool.query(`
    SELECT name, amount, scheduled_date, type
    FROM planned_expenses
    WHERE status = 'active'
      AND scheduled_date >= current_date
    ORDER BY scheduled_date ASC
  `);
  const plannedExpenses = plannedRows
    .filter(r => r.type !== 'income')
    .map(r => ({
      name: r.name,
      amount: Number(r.amount),
      scheduled_date: formatDateStr(r.scheduled_date)
    }));
  const plannedIncome = plannedRows
    .filter(r => r.type === 'income')
    .map(r => ({
      name: r.name,
      amount: Number(r.amount),
      scheduled_date: formatDateStr(r.scheduled_date)
    }));

  // 6. Run the engine
  const projections = computeForecast({
    starting_balance: startingBalance,
    recurring_income: recurringIncome,
    recurring_expenses: recurringExpenses,
    liability_payments: liabilityPayments,
    seasonal_baseline: seasonalBaseline,
    planned_expenses: plannedExpenses,
    planned_income: plannedIncome,
    horizon_days: horizonDays
  });

  const dangerZones = detectDangerZones(projections, safetyFloor);
  const monthlyOutlook = computeMonthlyOutlook(projections, startingBalance);

  // Committed monthly = sum of all recurring expense monthly equivalents
  const committedMonthly = recurringExpenses.reduce(
    (sum, r) => sum + monthlyEquivalent(r.amount, r.frequency),
    0
  );
  const excessLiquidity = detectExcessLiquidity(projections, {
    safetyFloor,
    committedMonthly,
    reserveTargetMonths,
    reserveTargetAmount: reserveTargetAmount ? parseFloat(reserveTargetAmount) : undefined
  });

  // 7. Build input fingerprint for staleness detection
  const fingerprint = buildFingerprint({
    startingBalance, horizonDays, safetyFloor, reserveTargetMonths,
    recurringCount: recurringRows.length,
    liabilityCount: liabilityRows.length,
    plannedCount: plannedExpenses.length,
    plannedIncomeCount: plannedIncome.length
  });

  // 8. Build meta
  const meta = {
    starting_balance: startingBalance,
    horizon_days: horizonDays,
    safety_floor: safetyFloor,
    computed_at: new Date().toISOString(),
    input_fingerprint: fingerprint,
    recurring_income_count: recurringIncome.length,
    recurring_expense_count: recurringExpenses.length,
    liability_count: liabilityPayments.length,
    planned_count: plannedExpenses.length,
    planned_income_count: plannedIncome.length
  };

  // 9. Cache the result (single-row, replace old)
  await pool.query('DELETE FROM cash_flow_snapshots');
  await pool.query(`
    INSERT INTO cash_flow_snapshots
      (horizon_days, starting_balance, input_fingerprint, daily_projections, danger_zones, monthly_outlook, excess_liquidity)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    horizonDays,
    startingBalance,
    fingerprint,
    JSON.stringify(projections),
    JSON.stringify(dangerZones),
    JSON.stringify(monthlyOutlook),
    JSON.stringify(excessLiquidity)
  ]);

  return {
    projections,
    danger_zones: dangerZones,
    monthly_outlook: monthlyOutlook,
    excess_liquidity: excessLiquidity,
    meta
  };
}

/**
 * Get forecast from cache if fresh, otherwise recompute.
 */
async function getForecast(cfg) {
  const cached = await getCachedForecast();
  if (cached) {
    return cached;
  }
  return computeAndCacheForecast(cfg);
}

/**
 * Get cached forecast if it exists.
 */
async function getCachedForecast() {
  const { rows } = await pool.query(`
    SELECT * FROM cash_flow_snapshots
    ORDER BY computed_at DESC
    LIMIT 1
  `);
  if (!rows.length) return null;

  const row = rows[0];
  const projections = row.daily_projections || [];

  // Derive input counts from cached projection events
  const allEvents = projections.flatMap(d => d.events || []);
  const uniqueByType = (type) => new Set(allEvents.filter(e => e.type === type).map(e => e.name)).size;

  return {
    projections,
    danger_zones: row.danger_zones,
    monthly_outlook: row.monthly_outlook,
    excess_liquidity: row.excess_liquidity || {},
    meta: {
      starting_balance: Number(row.starting_balance),
      horizon_days: row.horizon_days,
      computed_at: row.computed_at,
      input_fingerprint: row.input_fingerprint,
      cached: true,
      recurring_income_count: uniqueByType('income'),
      recurring_expense_count: uniqueByType('expense'),
      liability_count: uniqueByType('liability_payment'),
      planned_count: uniqueByType('planned_expense'),
      planned_income_count: uniqueByType('planned_income')
    }
  };
}

function buildFingerprint(inputs) {
  const json = JSON.stringify(inputs);
  return crypto.createHash('md5').update(json).digest('hex');
}

function formatDateStr(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

module.exports = {
  computeAndCacheForecast,
  getForecast,
  getCachedForecast,
  buildFingerprint,
  invalidateForecastCache
};

async function invalidateForecastCache() {
  await pool.query('DELETE FROM cash_flow_snapshots');
}
