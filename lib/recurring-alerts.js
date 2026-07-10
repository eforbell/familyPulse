'use strict';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const ACTIVE_STATUSES = new Set(['active', 'stale']);
const ALERT_EVENT_TYPES = new Set([
  'recurring_price_creep',
  'recurring_missed_income',
  'recurring_new_commitment'
]);

function formatMoney(value) {
  return USD.format(Number(value) || 0);
}

function formatDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function parseDateOnly(value) {
  const formatted = formatDateOnly(value);
  if (!formatted) return null;
  const date = new Date(`${formatted}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start, end) {
  const a = parseDateOnly(start);
  const b = parseDateOnly(end);
  if (!a || !b) return 0;
  return Math.floor((b - a) / 86400000);
}

function isAlertableStream(stream) {
  return stream && ACTIVE_STATUSES.has(stream.status) && stream.status !== 'paused' && stream.status !== 'ignored' && stream.status !== 'likely_cancelled';
}

function buildPriceCreepEvent(stream, { thresholdPct = 5 } = {}) {
  if (!isAlertableStream(stream)) return null;
  if (stream.cashflow_type !== 'expense') return null;
  if (stream.price_change_direction !== 'up') return null;
  const pct = Number(stream.price_change_pct);
  if (!Number.isFinite(pct) || pct < thresholdPct) return null;
  const changeDate = formatDateOnly(stream.price_change_date || stream.last_seen_date);
  if (!changeDate) return null;

  return {
    recurring_expense_id: stream.id,
    event_type: 'recurring_price_creep',
    source_key: `recurring:${stream.id}:price:${changeDate}`,
    title: 'Recurring price increase',
    message: `${stream.merchant_name} increased ${Math.round(pct)}% to ${formatMoney(stream.latest_amount)}.`,
    occurred_on: changeDate,
    payload: {
      recurring_expense_id: stream.id,
      merchant_name: stream.merchant_name,
      prior_amount: Number(stream.prior_amount),
      latest_amount: Number(stream.latest_amount),
      price_change_pct: pct,
      frequency: stream.override_frequency || stream.frequency,
      price_change_date: changeDate
    }
  };
}

function buildMissedIncomeEvent(stream, { asOfDate } = {}) {
  if (!isAlertableStream(stream)) return null;
  if (stream.cashflow_type !== 'income') return null;
  const expected = formatDateOnly(stream.override_expected_next_date || stream.expected_next_date);
  if (!expected) return null;
  const toleranceDays = Number(stream.tolerance_days ?? 0) || 0;
  const dueDate = parseDateOnly(expected);
  if (!dueDate) return null;
  dueDate.setUTCDate(dueDate.getUTCDate() + toleranceDays);
  const due = formatDateOnly(dueDate);
  const current = formatDateOnly(asOfDate || new Date());
  const daysLate = daysBetween(due, current);
  if (daysLate <= 0) return null;

  return {
    recurring_expense_id: stream.id,
    event_type: 'recurring_missed_income',
    source_key: `recurring:${stream.id}:missed-income:${expected}`,
    title: 'Expected income is late',
    message: `${stream.merchant_name} was expected ${expected} and is ${daysLate} day${daysLate === 1 ? '' : 's'} late.`,
    occurred_on: current,
    payload: {
      recurring_expense_id: stream.id,
      merchant_name: stream.merchant_name,
      expected_next_date: expected,
      tolerance_days: toleranceDays,
      days_late: daysLate,
      expected_amount: Number(stream.latest_amount),
      frequency: stream.override_frequency || stream.frequency
    }
  };
}

function buildNewCommitmentEvent(stream, { highWaterId = 0 } = {}) {
  if (!isAlertableStream(stream)) return null;
  if (stream.cashflow_type !== 'expense') return null;
  if (!['medium', 'high'].includes(stream.confidence)) return null;
  if (Number(stream.id) <= Number(highWaterId || 0)) return null;
  const firstSeen = formatDateOnly(stream.first_seen_date || stream.created_at || new Date());

  return {
    recurring_expense_id: stream.id,
    event_type: 'recurring_new_commitment',
    source_key: `recurring:${stream.id}:new-commitment`,
    title: 'New recurring commitment',
    message: `${stream.merchant_name} now looks recurring at ${formatMoney(stream.latest_amount)} ${stream.override_frequency || stream.frequency}.`,
    occurred_on: firstSeen,
    payload: {
      recurring_expense_id: stream.id,
      merchant_name: stream.merchant_name,
      latest_amount: Number(stream.latest_amount),
      frequency: stream.override_frequency || stream.frequency,
      confidence: stream.confidence,
      first_seen_date: firstSeen
    }
  };
}

function buildRecurringAlertEvents(streams, options = {}) {
  const events = [];
  for (const stream of streams || []) {
    for (const event of [
      buildPriceCreepEvent(stream, options),
      buildMissedIncomeEvent(stream, options),
      buildNewCommitmentEvent(stream, options)
    ]) {
      if (event) events.push(event);
    }
  }
  return events;
}

async function loadRecurringAlertConfig(client, cfg) {
  if (cfg) {
    return {
      priceCreepThresholdPct: Number(await cfg('price_creep_threshold_pct') || 5),
      newCommitmentHighWaterId: Number(await cfg('recurring_alerts_new_commitment_high_water_id') || 0)
    };
  }
  const { rows } = await client.query(`
    SELECT key, value
    FROM app_config
    WHERE key IN ('price_creep_threshold_pct', 'recurring_alerts_new_commitment_high_water_id')
  `);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    priceCreepThresholdPct: Number(values.price_creep_threshold_pct || 5),
    newCommitmentHighWaterId: Number(values.recurring_alerts_new_commitment_high_water_id || 0)
  };
}


async function resolveInactiveMissedIncomeAlerts(client, events) {
  const activeMissedSourceKeys = events
    .filter(event => event.event_type === 'recurring_missed_income')
    .map(event => event.source_key);

  if (activeMissedSourceKeys.length > 0) {
    await client.query(`
      UPDATE recurring_alert_events
      SET dismissed_at = now(),
          updated_at = now()
      WHERE event_type = 'recurring_missed_income'
        AND dismissed_at IS NULL
        AND source_key <> ALL($1::text[])
    `, [activeMissedSourceKeys]);
    return;
  }

  await client.query(`
    UPDATE recurring_alert_events
    SET dismissed_at = now(),
        updated_at = now()
    WHERE event_type = 'recurring_missed_income'
      AND dismissed_at IS NULL
  `);
}

async function generateRecurringAlertEvents(client, { asOfDate, cfg } = {}) {
  const config = await loadRecurringAlertConfig(client, cfg);
  const { rows: streams } = await client.query(`
    SELECT *
    FROM recurring_expenses
    WHERE status NOT IN ('ignored', 'paused', 'likely_cancelled')
  `);
  const events = buildRecurringAlertEvents(streams, {
    asOfDate,
    thresholdPct: config.priceCreepThresholdPct,
    highWaterId: config.newCommitmentHighWaterId
  });

  await resolveInactiveMissedIncomeAlerts(client, events);

  const inserted = [];
  for (const event of events) {
    if (!ALERT_EVENT_TYPES.has(event.event_type)) continue;
    const { rows: [row] } = await client.query(`
      INSERT INTO recurring_alert_events (
        recurring_expense_id, event_type, source_key, title, message, payload_json,
        occurred_on, last_seen_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::date, now(), now())
      ON CONFLICT (event_type, source_key)
      DO UPDATE SET
        last_seen_at = now(),
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        payload_json = EXCLUDED.payload_json,
        updated_at = now()
      RETURNING *
    `, [
      event.recurring_expense_id,
      event.event_type,
      event.source_key,
      event.title,
      event.message,
      JSON.stringify(event.payload || {}),
      event.occurred_on
    ]);
    inserted.push(row);
  }

  return { generated: inserted.length, events: inserted };
}

module.exports = {
  ALERT_EVENT_TYPES,
  buildMissedIncomeEvent,
  buildNewCommitmentEvent,
  buildPriceCreepEvent,
  buildRecurringAlertEvents,
  generateRecurringAlertEvents,
  loadRecurringAlertConfig,
  resolveInactiveMissedIncomeAlerts
};
