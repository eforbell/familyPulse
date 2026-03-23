'use strict';

const {
  computeExpectedNextDate,
  parseDateOnly,
  addDays,
  addMonths
} = require('./recurring-detector');

/**
 * Pure, deterministic day-by-day cash flow projection engine.
 *
 * No DB calls, no side effects — all inputs are pre-materialized.
 * This makes the engine fully testable with fixture data.
 *
 * @param {Object} inputs
 * @param {number}   inputs.starting_balance       — current liquid balance (from balance-policy.js)
 * @param {Array}    inputs.recurring_income        — [{ merchant_key, amount, frequency, last_seen_date, schedule_anchor_type, schedule_anchor_value, expected_next_date }]
 * @param {Array}    inputs.recurring_expenses      — same shape as recurring_income
 * @param {Array}    inputs.liability_payments      — [{ account_name, minimum_payment_amount, next_payment_due_date }]
 * @param {Array}    inputs.seasonal_baseline       — [{ month: 1-12, median_discretionary, median_recurring }]
 * @param {Array}    inputs.planned_expenses        — [{ name, amount, scheduled_date }]
 * @param {number}   [inputs.horizon_days]          — default 90
 * @param {string}   [inputs.start_date]            — YYYY-MM-DD, defaults to today
 * @returns {Array<{ date: string, projected_balance: number, confidence_low: number, confidence_high: number, events: Array }>}
 */
function computeForecast(inputs) {
  const {
    starting_balance,
    recurring_income = [],
    recurring_expenses = [],
    liability_payments = [],
    seasonal_baseline = [],
    planned_expenses = [],
    horizon_days = 90,
    start_date
  } = inputs;

  const startDate = start_date
    ? parseDateOnly(start_date)
    : parseDateOnly(new Date().toISOString().slice(0, 10));

  // Build lookup: month (1-12) → seasonal discretionary for that month
  const seasonalByMonth = new Map();
  for (const entry of seasonal_baseline) {
    seasonalByMonth.set(entry.month, entry);
  }

  // Pre-index planned expenses by date string
  const plannedByDate = new Map();
  for (const pe of planned_expenses) {
    const dateStr = typeof pe.scheduled_date === 'string'
      ? pe.scheduled_date
      : pe.scheduled_date.toISOString().slice(0, 10);
    if (!plannedByDate.has(dateStr)) {
      plannedByDate.set(dateStr, []);
    }
    plannedByDate.get(dateStr).push(pe);
  }

  // Pre-compute all recurring event dates within the horizon
  const recurringEventsByDate = new Map();
  projectRecurringEvents(recurring_income, 'income', startDate, horizon_days, recurringEventsByDate);
  projectRecurringEvents(recurring_expenses, 'expense', startDate, horizon_days, recurringEventsByDate);

  // Pre-compute liability payment dates within the horizon
  projectLiabilityPayments(liability_payments, startDate, horizon_days, recurringEventsByDate);

  // Day-by-day projection
  const projections = [];
  let balance = roundMoney(starting_balance);

  for (let day = 0; day < horizon_days; day++) {
    const currentDate = addDays(startDate, day);
    const dateStr = formatDate(currentDate);
    const events = [];

    // 1. Recurring events (income + expenses + liability payments)
    const dayEvents = recurringEventsByDate.get(dateStr) || [];
    for (const evt of dayEvents) {
      if (evt.type === 'income') {
        balance = roundMoney(balance + evt.amount);
      } else {
        balance = roundMoney(balance - evt.amount);
      }
      events.push(evt);
    }

    // 2. Planned one-time expenses
    const dayPlanned = plannedByDate.get(dateStr) || [];
    for (const pe of dayPlanned) {
      const amount = Math.abs(Number(pe.amount));
      balance = roundMoney(balance - amount);
      events.push({
        type: 'planned_expense',
        name: pe.name,
        amount
      });
    }

    // 3. Discretionary daily burn (seasonal baseline)
    const month = currentDate.getUTCMonth() + 1;
    const daysInMonth = new Date(
      Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() + 1, 0)
    ).getUTCDate();
    const seasonal = seasonalByMonth.get(month);
    const monthlyDiscretionary = seasonal ? seasonal.median_discretionary : 0;
    const dailyBurn = roundMoney(monthlyDiscretionary / daysInMonth);

    if (dailyBurn > 0) {
      balance = roundMoney(balance - dailyBurn);
      events.push({
        type: 'discretionary',
        name: 'Daily discretionary spending',
        amount: dailyBurn
      });
    }

    // 4. Confidence bands — deterministic heuristic
    const { low, high } = computeConfidenceBands(balance, day);

    projections.push({
      date: dateStr,
      projected_balance: balance,
      confidence_low: low,
      confidence_high: high,
      events
    });
  }

  return projections;
}

/**
 * Project recurring events (income or expenses) into a date-indexed map.
 * Walks forward from each item's expected_next_date (or computes from last_seen_date)
 * through the horizon, generating one event per occurrence.
 */
function projectRecurringEvents(items, type, startDate, horizonDays, eventsByDate) {
  const endDate = addDays(startDate, horizonDays);

  for (const item of items) {
    let nextDate = item.expected_next_date
      ? parseDateOnly(item.expected_next_date)
      : computeExpectedNextDate(
          parseDateOnly(item.last_seen_date),
          item.frequency,
          item.schedule_anchor_type,
          item.schedule_anchor_value
        );

    if (!nextDate) continue;

    const amount = Math.abs(Number(item.amount));
    const label = item.merchant_key || item.name || (type === 'income' ? 'Income' : 'Expense');

    // Walk forward through the horizon generating occurrences
    let safetyCounter = 0;
    while (nextDate < endDate && safetyCounter < 500) {
      safetyCounter++;

      if (nextDate >= startDate) {
        const dateStr = formatDate(nextDate);
        if (!eventsByDate.has(dateStr)) {
          eventsByDate.set(dateStr, []);
        }
        eventsByDate.get(dateStr).push({
          type,
          name: label,
          amount
        });
      }

      // Advance to the next occurrence
      nextDate = computeExpectedNextDate(
        nextDate,
        item.frequency,
        item.schedule_anchor_type,
        item.schedule_anchor_value
      );
      if (!nextDate) break;
    }
  }
}

/**
 * Project liability minimum payments forward through the horizon.
 * Uses the next_payment_due_date and assumes monthly recurrence thereafter.
 */
function projectLiabilityPayments(liabilities, startDate, horizonDays, eventsByDate) {
  const endDate = addDays(startDate, horizonDays);

  for (const liability of liabilities) {
    const amount = Math.abs(Number(liability.minimum_payment_amount));
    if (!amount || !liability.next_payment_due_date) continue;

    let nextDate = parseDateOnly(liability.next_payment_due_date);
    const label = liability.account_name || 'Liability payment';
    const anchorDay = nextDate.getUTCDate();

    let safetyCounter = 0;
    while (nextDate < endDate && safetyCounter < 12) {
      safetyCounter++;

      if (nextDate >= startDate) {
        const dateStr = formatDate(nextDate);
        if (!eventsByDate.has(dateStr)) {
          eventsByDate.set(dateStr, []);
        }
        eventsByDate.get(dateStr).push({
          type: 'liability_payment',
          name: label,
          amount
        });
      }

      // Advance monthly, anchored to the original day-of-month
      nextDate = addMonths(nextDate, 1);
      // Re-anchor to original day (handles short months)
      const monthEnd = new Date(
        Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 0)
      ).getUTCDate();
      nextDate = new Date(
        Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth(), Math.min(anchorDay, monthEnd))
      );
    }
  }
}

/**
 * Deterministic confidence bands.
 * ±5% at day 7, ±15% at day 30, ±25% at day 90.
 * Linear interpolation between these anchor points.
 */
function computeConfidenceBands(balance, dayIndex) {
  const absBalance = Math.abs(balance);

  let pct;
  if (dayIndex <= 0) {
    pct = 0;
  } else if (dayIndex <= 7) {
    pct = (dayIndex / 7) * 0.05;
  } else if (dayIndex <= 30) {
    pct = 0.05 + ((dayIndex - 7) / (30 - 7)) * (0.15 - 0.05);
  } else {
    pct = 0.15 + ((dayIndex - 30) / (90 - 30)) * (0.25 - 0.15);
  }
  // Cap at 25%
  pct = Math.min(pct, 0.25);

  const margin = roundMoney(absBalance * pct);
  return {
    low: roundMoney(balance - margin),
    high: roundMoney(balance + margin)
  };
}

/**
 * Detect danger zones from a forecast projection.
 *
 * A "danger" zone is any day where projected_balance < safety_floor.
 * An "at_risk" zone is any day where projected_balance >= safety_floor
 * but confidence_low < safety_floor (pessimistic band crosses floor).
 *
 * Returns an array of { date, projected_balance, deficit_below_floor, severity, trigger_event }.
 *
 * @param {Array} projections — output from computeForecast()
 * @param {number} safetyFloor — configurable floor (default $3000)
 * @returns {Array}
 */
function detectDangerZones(projections, safetyFloor = 3000) {
  const zones = [];

  for (const day of projections) {
    if (day.projected_balance < safetyFloor) {
      // Find the event that pushed the balance below the floor (largest expense/payment)
      const triggerEvent = findTriggerEvent(day.events);
      zones.push({
        date: day.date,
        projected_balance: day.projected_balance,
        deficit_below_floor: roundMoney(safetyFloor - day.projected_balance),
        severity: 'danger',
        trigger_event: triggerEvent
      });
    } else if (day.confidence_low < safetyFloor) {
      const triggerEvent = findTriggerEvent(day.events);
      zones.push({
        date: day.date,
        projected_balance: day.projected_balance,
        deficit_below_floor: roundMoney(safetyFloor - day.confidence_low),
        severity: 'at_risk',
        trigger_event: triggerEvent
      });
    }
  }

  return zones;
}

/**
 * Find the largest non-income event on a given day — the likely trigger for a danger zone.
 */
function findTriggerEvent(events) {
  let trigger = null;
  let maxAmount = 0;
  for (const evt of events) {
    if (evt.type !== 'income' && evt.amount > maxAmount) {
      maxAmount = evt.amount;
      trigger = evt;
    }
  }
  return trigger;
}

/**
 * Aggregate a forecast projection into monthly outlook summaries.
 *
 * Returns an array of month summaries: { month (YYYY-MM), expected_income,
 * expected_recurring, expected_discretionary, expected_liability_payments,
 * planned_expenses_total, net_surplus_or_deficit, projected_end_balance }.
 *
 * @param {Array} projections — output from computeForecast()
 * @param {number} startingBalance — balance at the start of the forecast
 * @returns {Array}
 */
function computeMonthlyOutlook(projections, startingBalance) {
  if (!projections.length) return [];

  // Group days by month
  const monthMap = new Map();
  for (const day of projections) {
    const month = day.date.slice(0, 7); // YYYY-MM
    if (!monthMap.has(month)) {
      monthMap.set(month, {
        month,
        expected_income: 0,
        expected_recurring: 0,
        expected_discretionary: 0,
        expected_liability_payments: 0,
        planned_expenses_total: 0
      });
    }
    const summary = monthMap.get(month);
    for (const evt of day.events) {
      switch (evt.type) {
        case 'income':
          summary.expected_income = roundMoney(summary.expected_income + evt.amount);
          break;
        case 'expense':
          summary.expected_recurring = roundMoney(summary.expected_recurring + evt.amount);
          break;
        case 'discretionary':
          summary.expected_discretionary = roundMoney(summary.expected_discretionary + evt.amount);
          break;
        case 'liability_payment':
          summary.expected_liability_payments = roundMoney(summary.expected_liability_payments + evt.amount);
          break;
        case 'planned_expense':
          summary.planned_expenses_total = roundMoney(summary.planned_expenses_total + evt.amount);
          break;
      }
    }
  }

  // Chain end balances: start of first month = startingBalance
  const months = [...monthMap.values()];
  let runningBalance = roundMoney(startingBalance);

  for (const m of months) {
    const net = roundMoney(
      m.expected_income
      - m.expected_recurring
      - m.expected_discretionary
      - m.expected_liability_payments
      - m.planned_expenses_total
    );
    m.net_surplus_or_deficit = net;
    runningBalance = roundMoney(runningBalance + net);
    m.projected_end_balance = runningBalance;
  }

  return months;
}

/**
 * Detect excess liquidity opportunity from a forecast projection.
 *
 * @param {Array} projections — output from computeForecast()
 * @param {Object} options
 * @param {number}  options.safetyFloor — cash_flow_safety_floor (default $3000)
 * @param {number}  options.committedMonthly — total monthly committed recurring expenses
 * @param {number}  options.reserveTargetMonths — how many months of committed expenses to keep (default 3.0)
 * @param {number}  [options.reserveTargetAmount] — explicit override for reserve target in dollars
 * @returns {{ reserve_target: number, projected_min_balance: number, excess_amount: number, recommendation_level: string }}
 */
function detectExcessLiquidity(projections, options = {}) {
  const {
    safetyFloor = 3000,
    committedMonthly = 0,
    reserveTargetMonths = 3.0,
    reserveTargetAmount
  } = options;

  // Reserve target: max of safety floor, month-based target, and explicit override
  const monthBasedTarget = roundMoney(committedMonthly * reserveTargetMonths);
  const reserveTarget = Math.max(
    safetyFloor,
    monthBasedTarget,
    reserveTargetAmount != null ? reserveTargetAmount : 0
  );

  // Find the minimum projected balance over the full horizon
  let minBalance = Infinity;
  for (const day of projections) {
    if (day.projected_balance < minBalance) {
      minBalance = day.projected_balance;
    }
  }
  if (!projections.length) minBalance = 0;

  const excessAmount = roundMoney(Math.max(0, minBalance - reserveTarget));

  let recommendationLevel = 'none';
  if (excessAmount > 0 && committedMonthly > 0) {
    recommendationLevel = excessAmount >= committedMonthly ? 'strong' : 'modest';
  } else if (excessAmount > 0 && committedMonthly === 0) {
    // No recurring data — can't judge relative to committed, so modest
    recommendationLevel = 'modest';
  }

  return {
    reserve_target: reserveTarget,
    projected_min_balance: roundMoney(minBalance),
    excess_amount: excessAmount,
    recommendation_level: recommendationLevel
  };
}

function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  computeForecast,
  detectDangerZones,
  computeMonthlyOutlook,
  detectExcessLiquidity,
  // Exported for testing
  projectRecurringEvents,
  projectLiabilityPayments,
  computeConfidenceBands,
  findTriggerEvent,
  formatDate,
  roundMoney
};
