'use strict';

const { pool, withTransaction } = require('./db');
const logger = require('./logger');
const { buildMerchantFingerprint } = require('./merchant-normalizer');

const FREQUENCY_WINDOWS = [
  { frequency: 'weekly', minDays: 5, maxDays: 9, intervalDays: 7, toleranceDays: 2, minOccurrences: 3 },
  { frequency: 'biweekly', minDays: 12, maxDays: 16, intervalDays: 14, toleranceDays: 2, minOccurrences: 3 },
  { frequency: 'monthly', minDays: 27, maxDays: 34, intervalDays: 30, toleranceDays: 3, minOccurrences: 2 },
  { frequency: 'quarterly', minDays: 85, maxDays: 100, intervalDays: 91, toleranceDays: 7, minOccurrences: 2 },
  { frequency: 'semi-annual', minDays: 170, maxDays: 195, intervalDays: 182, toleranceDays: 10, minOccurrences: 2 },
  { frequency: 'annual', minDays: 350, maxDays: 380, intervalDays: 365, toleranceDays: 14, minOccurrences: 2 }
];

function parseDateOnly(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const monthStart = new Date(Date.UTC(year, month + months, 1));
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
  const targetDay = Math.min(day, monthEnd.getUTCDate());
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), targetDay));
}

function isLastDayOfMonth(date) {
  return addDays(date, 1).getUTCDate() === 1;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function coefficientOfVariation(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!mean) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function transactionDirection(amount) {
  return Number(amount) < 0 ? 'income' : 'expense';
}

function isRecurringCandidateTransaction(tx) {
  if (!tx) return false;
  if (tx.pending || tx.is_transfer || tx.is_hidden) return false;
  if (transactionDirection(tx.amount) === 'expense' && tx.transfer_type) return false;
  if (tx.is_transfer_class) return false;
  return true;
}

function findFrequencyByInterval(intervalDays, occurrenceCount) {
  return FREQUENCY_WINDOWS.find(window =>
    intervalDays >= window.minDays &&
    intervalDays <= window.maxDays &&
    occurrenceCount >= window.minOccurrences
  ) || null;
}

function buildAmountCluster(transactions, tolerancePct) {
  const amounts = transactions.map(tx => Math.abs(Number(tx.amount)));
  const medianAmount = median(amounts);
  if (!medianAmount) return { transactions, medianAmount };

  const cluster = transactions.filter(tx => {
    const amount = Math.abs(Number(tx.amount));
    return Math.abs(amount - medianAmount) <= (medianAmount * tolerancePct);
  });

  if (cluster.length >= 2) {
    // Detect level shift: if recent consecutive transactions were all excluded,
    // they may represent a permanent amount change (e.g. pay raise).
    // In that case, include ALL transactions for interval detection but report
    // the new median amount.
    const clusterSet = new Set(cluster.map(tx => tx.id || tx.date));
    let tailStart = transactions.length;
    for (let i = transactions.length - 1; i >= 0; i--) {
      const key = transactions[i].id || transactions[i].date;
      if (clusterSet.has(key)) break;
      tailStart = i;
    }
    const tail = transactions.slice(tailStart);
    if (tail.length >= 2) {
      const tailMedian = median(tail.map(tx => Math.abs(Number(tx.amount))));
      const tailCluster = tail.filter(tx => {
        const amount = Math.abs(Number(tx.amount));
        return Math.abs(amount - tailMedian) <= (tailMedian * tolerancePct);
      });
      if (tailCluster.length >= 2) {
        return { transactions, medianAmount: tailMedian };
      }
    }
    return { transactions: cluster, medianAmount };
  }

  return { transactions, medianAmount };
}

function inferScheduleAnchor(dates, frequency) {
  if (!dates.length) return { schedule_anchor_type: null, schedule_anchor_value: null };

  const lastDate = dates[dates.length - 1];
  if (frequency === 'weekly' || frequency === 'biweekly') {
    return {
      schedule_anchor_type: 'weekday',
      schedule_anchor_value: String(lastDate.getUTCDay())
    };
  }

  if (frequency === 'monthly' || frequency === 'quarterly' || frequency === 'semi-annual' || frequency === 'annual') {
    if (dates.every(isLastDayOfMonth)) {
      return {
        schedule_anchor_type: 'last_day_of_month',
        schedule_anchor_value: 'last'
      };
    }
    return {
      schedule_anchor_type: 'day_of_month',
      schedule_anchor_value: String(lastDate.getUTCDate())
    };
  }

  return { schedule_anchor_type: null, schedule_anchor_value: null };
}

function computeExpectedNextDate(lastSeenDate, frequency, scheduleAnchorType, scheduleAnchorValue) {
  switch (frequency) {
    case 'weekly':
      return addDays(lastSeenDate, 7);
    case 'biweekly':
      return addDays(lastSeenDate, 14);
    case 'monthly': {
      const next = addMonths(lastSeenDate, 1);
      if (scheduleAnchorType === 'last_day_of_month') {
        return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0));
      }
      if (scheduleAnchorType === 'day_of_month') {
        const day = Number(scheduleAnchorValue) || next.getUTCDate();
        const monthEnd = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0));
        return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(day, monthEnd.getUTCDate())));
      }
      return next;
    }
    case 'quarterly':
      return addMonths(lastSeenDate, 3);
    case 'semi-annual':
      return addMonths(lastSeenDate, 6);
    case 'annual':
      return addMonths(lastSeenDate, 12);
    default:
      return null;
  }
}

function determineStatus(lastSeenDate, intervalDays, asOfDate) {
  if (!intervalDays) return 'active';
  const elapsedDays = Math.floor((asOfDate - lastSeenDate) / 86400000);
  if (elapsedDays >= intervalDays * 4) return 'likely_cancelled';
  if (elapsedDays >= intervalDays * 2) return 'stale';
  return 'active';
}

function computeConfidence(intervals, clusteredTransactions, medianAmount) {
  const intervalCv = coefficientOfVariation(intervals);
  const amountCv = coefficientOfVariation(clusteredTransactions.map(tx => Math.abs(Number(tx.amount))));

  if (intervalCv <= 0.15 && amountCv <= 0.10) return 'high';
  if (intervalCv <= 0.30 || amountCv <= 0.20) return 'medium';
  if (clusteredTransactions.length >= 2 && medianAmount > 0) return 'low';
  return 'low';
}

function analyzeRecurringGroup(transactions, options = {}) {
  const tolerancePct = Number(options.amountTolerancePct ?? 0.10);
  const asOfDate = parseDateOnly(options.asOfDate || new Date().toISOString().slice(0, 10));

  const eligible = transactions
    .filter(isRecurringCandidateTransaction)
    .map(tx => ({
      ...tx,
      amount: Number(tx.amount),
      date: typeof tx.date === 'string' ? tx.date : formatDateOnly(parseDateOnly(tx.date)),
      cashflow_type: tx.cashflow_type || transactionDirection(tx.amount)
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (eligible.length < 2) return null;

  const { transactions: clustered, medianAmount } = buildAmountCluster(eligible, tolerancePct);
  const dates = clustered.map(tx => parseDateOnly(tx.date));
  if (dates.length < 2) return null;

  const intervals = [];
  for (let i = 1; i < dates.length; i++) {
    intervals.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
  }

  const medianInterval = median(intervals);
  const matchedFrequency = findFrequencyByInterval(medianInterval, clustered.length);
  if (!matchedFrequency) return null;

  const anchor = inferScheduleAnchor(dates, matchedFrequency.frequency);
  const lastSeenDate = dates[dates.length - 1];
  const expectedNextDate = computeExpectedNextDate(
    lastSeenDate,
    matchedFrequency.frequency,
    anchor.schedule_anchor_type,
    anchor.schedule_anchor_value
  );

  const latest = clustered[clustered.length - 1];
  const prior = clustered.length > 1 ? clustered[clustered.length - 2] : null;
  const latestAmount = Math.abs(Number(latest.amount));
  const priorAmount = prior ? Math.abs(Number(prior.amount)) : null;
  const priceChangePct = priorAmount
    ? Math.round((((latestAmount - priorAmount) / priorAmount) * 100) * 100) / 100
    : null;
  const priceChangeDirection = priceChangePct == null || priceChangePct === 0
    ? null
    : (priceChangePct > 0 ? 'up' : 'down');

  return {
    merchant_key: buildMerchantFingerprint(latest),
    merchant_name: latest.merchant_name || latest.name || 'Unknown',
    cashflow_type: latest.cashflow_type,
    frequency: matchedFrequency.frequency,
    confidence: computeConfidence(intervals, clustered, medianAmount),
    status: determineStatus(lastSeenDate, matchedFrequency.intervalDays, asOfDate),
    latest_account_id: latest.account_id || null,
    latest_transaction_id: latest.id || null,
    latest_amount: Math.round(latestAmount * 100) / 100,
    prior_amount: priorAmount == null ? null : Math.round(priorAmount * 100) / 100,
    price_change_pct: priceChangePct,
    price_change_direction: priceChangeDirection,
    price_change_date: priceChangeDirection ? latest.date : null,
    first_seen_date: clustered[0].date,
    last_seen_date: latest.date,
    expected_next_date: expectedNextDate ? formatDateOnly(expectedNextDate) : null,
    interval_days: matchedFrequency.intervalDays,
    tolerance_days: matchedFrequency.toleranceDays,
    schedule_anchor_type: anchor.schedule_anchor_type,
    schedule_anchor_value: anchor.schedule_anchor_value,
    source_txn_count: clustered.length,
    transactions: clustered.map(tx => ({
      id: tx.id || null,
      account_id: tx.account_id || null,
      amount: Math.abs(Number(tx.amount)),
      date: tx.date
    }))
  };
}

function detectRecurringCandidates(transactions, options = {}) {
  const grouped = new Map();

  for (const tx of transactions) {
    const key = `${buildMerchantFingerprint(tx)}::${tx.cashflow_type || transactionDirection(tx.amount)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(tx);
  }

  return [...grouped.values()]
    .map(group => analyzeRecurringGroup(group, options))
    .filter(Boolean);
}

async function detectRecurringCashflows(options = {}) {
  const config = await getRecurringConfig(options.cfg);
  const lookbackMonths = Number(options.lookbackMonths ?? config.lookbackMonths);
  const amountTolerancePct = Number(options.amountTolerancePct ?? config.amountTolerancePct);
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const lastDetectionAt = options.lastDetectionAt ?? config.lastDetectionAt;
  const incremental = options.incremental !== false && Boolean(lastDetectionAt) && !options.forceFullScan;
  const cutoff = addMonths(parseDateOnly(asOfDate), -lookbackMonths);

  const { rows } = await pool.query(`
    SELECT t.id, t.account_id, t.amount, t.date, t.merchant_name, t.name,
           t.pending, t.is_transfer, t.is_hidden, t.transfer_type,
           t.updated_at,
           c.is_transfer_class
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.date >= $1::date
    ORDER BY t.date ASC, t.id ASC
  `, [formatDateOnly(cutoff)]);

  let sourceRows = rows;
  if (incremental) {
    const changedKeys = new Set(rows
      .filter(row => row.updated_at && new Date(row.updated_at) >= new Date(lastDetectionAt))
      .map(row => `${buildMerchantFingerprint(row)}::${row.cashflow_type || transactionDirection(row.amount)}`));
    sourceRows = changedKeys.size > 0
      ? rows.filter(row => changedKeys.has(`${buildMerchantFingerprint(row)}::${row.cashflow_type || transactionDirection(row.amount)}`))
      : [];
  }

  const candidates = detectRecurringCandidates(sourceRows, { amountTolerancePct, asOfDate });

  const persisted = await withTransaction(async client => {
    const items = [];
    for (const candidate of candidates) {
      const item = await upsertRecurringCandidate(client, candidate, asOfDate);
      items.push(item);
    }

    await refreshRecurringStatuses(client, asOfDate);

    await client.query(`
      INSERT INTO app_config (key, value) VALUES ('recurring_last_detection_at', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [new Date().toISOString()]);

    return items;
  });

  logger.info('Recurring detection analyzed transaction history', {
    candidates: persisted.length,
    lookbackMonths,
    incremental,
    changed_groups: sourceRows.length
  });
  return { candidates: persisted, incremental };
}

async function getRecurringConfig(cfg) {
  if (cfg) {
    const tolerancePct = parseFloat(await cfg('recurring_amount_tolerance_pct') || '10');
    const lookbackMonths = parseInt(await cfg('recurring_lookback_months') || '18', 10);
    const lastDetectionAt = await cfg('recurring_last_detection_at');
    return {
      amountTolerancePct: tolerancePct / 100,
      lookbackMonths,
      lastDetectionAt: lastDetectionAt || null
    };
  }

  const { rows } = await pool.query(`
    SELECT key, value FROM app_config
    WHERE key IN ('recurring_amount_tolerance_pct', 'recurring_lookback_months', 'recurring_last_detection_at')
  `);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    amountTolerancePct: (parseFloat(values.recurring_amount_tolerance_pct || '10') || 10) / 100,
    lookbackMonths: parseInt(values.recurring_lookback_months || '18', 10) || 18,
    lastDetectionAt: values.recurring_last_detection_at || null
  };
}

async function upsertRecurringCandidate(client, candidate, asOfDate) {
  const { rows: [row] } = await client.query(`
    INSERT INTO recurring_expenses (
      merchant_key, merchant_name, cashflow_type, frequency, confidence, status,
      latest_account_id, latest_amount, prior_amount, price_change_pct, price_change_direction,
      price_change_date, first_seen_date, last_seen_date, expected_next_date, interval_days,
      tolerance_days, schedule_anchor_type, schedule_anchor_value, source_txn_count, last_detected_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      now()
    )
    ON CONFLICT (
      merchant_key,
      cashflow_type,
      frequency,
      COALESCE(schedule_anchor_type, ''),
      COALESCE(schedule_anchor_value, '')
    )
    DO UPDATE SET
      merchant_name = EXCLUDED.merchant_name,
      confidence = EXCLUDED.confidence,
      status = CASE
        WHEN recurring_expenses.status IN ('paused', 'ignored') THEN recurring_expenses.status
        ELSE EXCLUDED.status
      END,
      latest_account_id = EXCLUDED.latest_account_id,
      latest_amount = EXCLUDED.latest_amount,
      prior_amount = EXCLUDED.prior_amount,
      price_change_pct = EXCLUDED.price_change_pct,
      price_change_direction = EXCLUDED.price_change_direction,
      price_change_date = EXCLUDED.price_change_date,
      first_seen_date = LEAST(recurring_expenses.first_seen_date, EXCLUDED.first_seen_date),
      last_seen_date = GREATEST(recurring_expenses.last_seen_date, EXCLUDED.last_seen_date),
      expected_next_date = COALESCE(recurring_expenses.override_expected_next_date, EXCLUDED.expected_next_date),
      interval_days = EXCLUDED.interval_days,
      tolerance_days = EXCLUDED.tolerance_days,
      source_txn_count = EXCLUDED.source_txn_count,
      last_detected_at = EXCLUDED.last_detected_at,
      updated_at = now()
    RETURNING *
  `, [
    candidate.merchant_key,
    candidate.merchant_name,
    candidate.cashflow_type,
    candidate.frequency,
    candidate.confidence,
    candidate.status,
    candidate.latest_account_id,
    candidate.latest_amount,
    candidate.prior_amount,
    candidate.price_change_pct,
    candidate.price_change_direction,
    candidate.price_change_date,
    candidate.first_seen_date,
    candidate.last_seen_date,
    candidate.expected_next_date,
    candidate.interval_days,
    candidate.tolerance_days,
    candidate.schedule_anchor_type,
    candidate.schedule_anchor_value,
    candidate.source_txn_count,
    asOfDate
  ]);

  if (candidate.latest_transaction_id != null) {
    await client.query(`
      INSERT INTO recurring_expense_history (recurring_expense_id, transaction_id, amount, transaction_date)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (recurring_expense_id, transaction_date, amount) DO NOTHING
    `, [row.id, candidate.latest_transaction_id, candidate.latest_amount, candidate.last_seen_date]);
  }

  return row;
}

async function refreshRecurringStatuses(client, asOfDate) {
  const effectiveDate = asOfDate || new Date().toISOString().slice(0, 10);
  await client.query(`
    UPDATE recurring_expenses
    SET status = CASE
      WHEN interval_days IS NULL THEN status
      WHEN ($1::date - last_seen_date) >= (interval_days * 4) THEN 'likely_cancelled'
      WHEN ($1::date - last_seen_date) >= (interval_days * 2) THEN 'stale'
      ELSE 'active'
    END,
    updated_at = now()
    WHERE status NOT IN ('paused', 'ignored')
  `, [effectiveDate]);
}

function monthlyEquivalent(amount, frequency) {
  const value = Number(amount) || 0;
  switch (frequency) {
    case 'weekly': return value * 4.33;
    case 'biweekly': return value * 2.17;
    case 'monthly': return value;
    case 'quarterly': return value / 3;
    case 'semi-annual': return value / 6;
    case 'annual': return value / 12;
    default: return value;
  }
}

async function getRecurringSummary() {
  const { rows } = await pool.query(`
    SELECT *
    FROM recurring_expenses
    WHERE status NOT IN ('ignored', 'likely_cancelled')
  `);

  let committedMonthlyTotal = 0;
  let recurringIncomeMonthlyTotal = 0;
  let activeCount = 0;
  let priceIncreaseCount = 0;
  let staleCount = 0;

  for (const row of rows) {
    const confidenceOkay = row.confidence === 'medium' || row.confidence === 'high';
    if (row.status === 'stale') staleCount++;
    if (row.price_change_direction === 'up') priceIncreaseCount++;
    if (row.status !== 'active' || !confidenceOkay) continue;

    activeCount++;
    const monthly = monthlyEquivalent(row.latest_amount, row.frequency);
    if (row.cashflow_type === 'income') recurringIncomeMonthlyTotal += monthly;
    if (row.cashflow_type === 'expense') committedMonthlyTotal += monthly;
  }

  return {
    committed_monthly_total: Math.round(committedMonthlyTotal * 100) / 100,
    recurring_income_monthly_total: Math.round(recurringIncomeMonthlyTotal * 100) / 100,
    active_count: activeCount,
    price_increase_count: priceIncreaseCount,
    stale_count: staleCount
  };
}

module.exports = {
  FREQUENCY_WINDOWS,
  addDays,
  addMonths,
  analyzeRecurringGroup,
  buildAmountCluster,
  coefficientOfVariation,
  computeExpectedNextDate,
  detectRecurringCandidates,
  detectRecurringCashflows,
  determineStatus,
  findFrequencyByInterval,
  getRecurringConfig,
  getRecurringSummary,
  inferScheduleAnchor,
  isRecurringCandidateTransaction,
  median,
  monthlyEquivalent,
  parseDateOnly,
  refreshRecurringStatuses,
  transactionDirection,
  upsertRecurringCandidate
};
