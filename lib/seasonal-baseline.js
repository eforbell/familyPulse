'use strict';

const { pool } = require('./db');
const { buildMerchantFingerprint } = require('./merchant-normalizer');

/**
 * Compute a seasonal spending baseline: median discretionary spend per calendar month.
 *
 * Discretionary = total expense spending minus amounts attributable to active recurring
 * cashflow items. Transfers, income, hidden, and pending transactions are excluded.
 *
 * Returns an array of 12 entries (months 1–12) with:
 *   { month, median_discretionary, sample_months, confidence }
 *
 * When a calendar month has no historical data, falls back to the overall monthly average.
 */
async function computeSeasonalBaseline(options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const lookbackMonths = options.lookbackMonths || 18;

  // Active recurring merchant keys — used to subtract recurring spend from discretionary
  const recurringKeys = await getActiveRecurringMerchantKeys();

  // Fetch all qualifying expense transactions within the lookback window
  const cutoffDate = subtractMonths(asOfDate, lookbackMonths);
  const currentMonth = asOfDate.slice(0, 7); // YYYY-MM of current incomplete month

  const { rows: txRows } = await pool.query(`
    SELECT t.amount, t.date, t.merchant_name, t.name
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.date >= $1::date
      AND t.date < date_trunc('month', $2::date) -- exclude current incomplete month
      AND t.amount > 0                            -- expenses only (positive = debit in Plaid)
      AND t.pending = false
      AND t.is_hidden = false
      AND t.is_transfer = false
      AND (c.is_income IS NULL OR c.is_income = false)
      AND (c.is_transfer_class IS NULL OR c.is_transfer_class = false)
    ORDER BY t.date ASC
  `, [cutoffDate, asOfDate]);

  // Bucket transactions by calendar month
  const monthlyBuckets = bucketByCalendarMonth(txRows, recurringKeys);

  // Compute per-calendar-month medians
  const baseline = buildBaseline(monthlyBuckets);

  return baseline;
}

/**
 * Pure computation: given pre-fetched transactions and recurring keys,
 * compute the seasonal baseline. Useful for testing with fixture data.
 */
function computeSeasonalBaselineFromData(transactions, recurringKeys = new Set()) {
  const monthlyBuckets = bucketByCalendarMonth(transactions, recurringKeys);
  return buildBaseline(monthlyBuckets);
}

/**
 * Get merchant keys for all active recurring items with medium+ confidence.
 */
async function getActiveRecurringMerchantKeys() {
  try {
    const { rows } = await pool.query(`
      SELECT merchant_key
      FROM recurring_expenses
      WHERE status = 'active'
        AND confidence IN ('medium', 'high')
    `);
    return new Set(rows.map(r => r.merchant_key));
  } catch {
    // recurring_expenses table may not exist yet
    return new Set();
  }
}

/**
 * Bucket transactions by calendar month (1-12), separating recurring from discretionary.
 */
function bucketByCalendarMonth(transactions, recurringKeys) {
  // Map: calendarMonth (1-12) -> Map: yearMonth (YYYY-MM) -> { total, recurring, discretionary }
  const buckets = new Map();
  for (let m = 1; m <= 12; m++) {
    buckets.set(m, new Map());
  }

  for (const tx of transactions) {
    const dateStr = typeof tx.date === 'string' ? tx.date : tx.date.toISOString().slice(0, 10);
    const month = parseInt(dateStr.slice(5, 7), 10);
    const yearMonth = dateStr.slice(0, 7);
    const amount = Math.abs(Number(tx.amount));

    const monthBucket = buckets.get(month);
    if (!monthBucket.has(yearMonth)) {
      monthBucket.set(yearMonth, { total: 0, recurring: 0, discretionary: 0 });
    }

    const entry = monthBucket.get(yearMonth);
    entry.total += amount;

    const fingerprint = buildMerchantFingerprint(tx);
    if (recurringKeys.has(fingerprint)) {
      entry.recurring += amount;
    } else {
      entry.discretionary += amount;
    }
  }

  return buckets;
}

/**
 * Build the baseline array from bucketed monthly data.
 */
function buildBaseline(monthlyBuckets) {
  const result = [];
  const allDiscretionary = [];

  // First pass: compute medians per calendar month
  for (let month = 1; month <= 12; month++) {
    const bucket = monthlyBuckets.get(month);
    const yearMonths = [...bucket.values()];

    if (yearMonths.length === 0) {
      result.push({
        month,
        median_total: 0,
        median_recurring: 0,
        median_discretionary: 0,
        sample_months: 0,
        confidence: 'none'
      });
      continue;
    }

    const totals = yearMonths.map(ym => ym.total);
    const recurringAmounts = yearMonths.map(ym => ym.recurring);
    const discretionaryAmounts = yearMonths.map(ym => ym.discretionary);

    discretionaryAmounts.forEach(d => allDiscretionary.push(d));

    result.push({
      month,
      median_total: roundMoney(median(totals)),
      median_recurring: roundMoney(median(recurringAmounts)),
      median_discretionary: roundMoney(median(discretionaryAmounts)),
      sample_months: yearMonths.length,
      confidence: yearMonths.length >= 2 ? 'good' : 'limited'
    });
  }

  // Second pass: fill empty months with overall average
  const overallMedian = allDiscretionary.length > 0
    ? roundMoney(median(allDiscretionary))
    : 0;

  for (const entry of result) {
    if (entry.sample_months === 0) {
      entry.median_discretionary = overallMedian;
      entry.median_total = overallMedian;
      entry.confidence = 'fallback';
    }
  }

  return result;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function subtractMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  computeSeasonalBaseline,
  computeSeasonalBaselineFromData,
  getActiveRecurringMerchantKeys,
  // Exported for testing
  bucketByCalendarMonth,
  buildBaseline,
  median
};
