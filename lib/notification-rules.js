'use strict';

const { getMonthlyBudgetSummary } = require('./budget-calculator');

const EVENT_TYPES = [
  {
    key: 'month_in_review',
    label: 'Month in Review',
    description: 'Soft reminder to open Pulse and review the month.'
  },
  {
    key: 'large_expense',
    label: 'Large Expense',
    description: 'Notify when a real expense above the threshold is first observed.'
  },
  {
    key: 'sync_issue',
    label: 'Sync Issue',
    description: 'Notify when Plaid sync needs attention or starts failing.'
  },
  {
    key: 'budget_overrun',
    label: 'Budget Overrun',
    description: 'Notify when a category first crosses the monthly over-budget threshold.'
  },
  {
    key: 'recurring_price_creep',
    label: 'Recurring Price Creep',
    description: 'Notify when a recurring expense increases past the configured threshold.'
  },
  {
    key: 'recurring_missed_income',
    label: 'Missed Income',
    description: 'Notify when expected recurring income is late beyond its tolerance window.'
  },
  {
    key: 'recurring_new_commitment',
    label: 'New Recurring Commitment',
    description: 'Notify when a new medium/high-confidence recurring expense appears.'
  }
];

const EVENT_TYPE_KEYS = new Set(EVENT_TYPES.map(event => event.key));
const GLOBAL_CONFIG_KEYS = [
  'notifications_enabled',
  'notification_base_url',
  'notification_default_interruption_level',
  'large_expense_threshold',
  'budget_overrun_threshold_pct',
  'price_creep_threshold_pct'
];

const DEFAULT_CONFIG = {
  notifications_enabled: 'false',
  notification_base_url: '',
  notification_default_interruption_level: 'active',
  large_expense_threshold: '1000',
  budget_overrun_threshold_pct: '15',
  price_creep_threshold_pct: '5'
};

const ALLOWED_INTERRUPTION_LEVELS = new Set(['passive', 'active', 'time-sensitive']);
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const APP_NOTIFICATION_PREFIX = 'Family Pulse:';

async function getNotificationConfig(cfgReader) {
  const entries = await Promise.all(
    GLOBAL_CONFIG_KEYS.map(async key => [key, await cfgReader(key)])
  );
  return Object.fromEntries(entries.map(([key, value]) => [key, value ?? DEFAULT_CONFIG[key]]));
}

function validateNotificationConfigValue(key, value) {
  switch (key) {
    case 'notifications_enabled':
      return value === true || String(value).trim() === 'true' ? 'true' : 'false';
    case 'notification_base_url': {
      const normalized = String(value || '').trim().replace(/\/+$/, '');
      if (!normalized) return '';
      let url;
      try {
        url = new URL(normalized);
      } catch {
        throw new Error('notification_base_url must be a valid absolute URL');
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('notification_base_url must use http or https');
      }
      return normalized;
    }
    case 'notification_default_interruption_level': {
      const normalized = String(value || '').trim() || DEFAULT_CONFIG.notification_default_interruption_level;
      if (!ALLOWED_INTERRUPTION_LEVELS.has(normalized)) {
        throw new Error('notification_default_interruption_level must be passive, active, or time-sensitive');
      }
      return normalized;
    }
    case 'large_expense_threshold': {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('large_expense_threshold must be a positive number');
      }
      return String(Math.round(amount * 100) / 100);
    }
    case 'budget_overrun_threshold_pct':
    case 'price_creep_threshold_pct': {
      const pct = Number(value);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 1000) {
        throw new Error(`${key} must be a positive percentage`);
      }
      return String(Math.round(pct * 100) / 100);
    }
    default:
      throw new Error('Unsupported notification config key');
  }
}

function normalizeNotificationSubscriptions(subscriptions = {}) {
  const normalized = {};
  for (const event of EVENT_TYPES) {
    normalized[event.key] = subscriptions[event.key] === true;
  }
  return normalized;
}

function buildOpenUrl(baseUrl, appPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const nextPath = String(appPath || '').trim();
  if (!base || !nextPath) return null;
  return `${base}/${nextPath.replace(/^\/+/, '')}`;
}

function formatMoney(value) {
  return USD.format(Number(value) || 0);
}

function withAppTitle(title) {
  const trimmed = String(title || '').trim();
  return trimmed ? `${APP_NOTIFICATION_PREFIX} ${trimmed}` : 'Family Pulse';
}

function parseConfigNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function loadSubscribedMembers(pool) {
  const { rows } = await pool.query(`
    SELECT
      mnc.member_id,
      mnc.target_secret,
      mns.event_type
    FROM member_notification_channels mnc
    JOIN family_members fm ON fm.id = mnc.member_id
    JOIN member_notification_subscriptions mns
      ON mns.member_id = mnc.member_id
    WHERE fm.role = 'parent'
      AND mnc.channel_type = 'brrr'
      AND mnc.enabled = true
      AND mnc.target_secret IS NOT NULL
      AND mnc.target_secret <> ''
      AND mns.enabled = true
    ORDER BY mnc.member_id, mns.event_type
  `);

  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_type)) byEvent.set(row.event_type, []);
    byEvent.get(row.event_type).push({
      member_id: row.member_id,
      target_secret: row.target_secret
    });
  }
  return byEvent;
}

async function loadEventStates(pool, eventType, memberIds, sourceKeys) {
  if (!memberIds.length || !sourceKeys.length) return new Map();
  const { rows } = await pool.query(`
    SELECT member_id, source_key, last_sent_at, cooldown_until
    FROM notification_event_state
    WHERE event_type = $1
      AND member_id = ANY($2::int[])
      AND source_key = ANY($3::text[])
  `, [eventType, memberIds, sourceKeys]);

  return new Map(rows.map(row => [`${row.member_id}:${row.source_key}`, row]));
}

function stateAllowsSend(state, now, { repeatable = false } = {}) {
  if (!state) return true;
  if (state.cooldown_until && new Date(state.cooldown_until) > now) return false;
  if (!repeatable && state.last_sent_at) return false;
  return true;
}

async function buildLargeExpenseCandidates({ pool, config, byEvent, now }) {
  const subscribers = byEvent.get('large_expense') || [];
  if (!subscribers.length) return [];

  const threshold = parseConfigNumber(config.large_expense_threshold, 1000);
  const { rows: txns } = await pool.query(`
    SELECT
      t.id,
      t.amount,
      t.date,
      t.name,
      t.merchant_name,
      c.name AS category_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount >= $1
      AND t.amount > 0
      AND t.pending = false
      AND t.is_transfer = false
      AND t.is_hidden = false
      AND COALESCE(c.is_income, false) = false
      AND COALESCE(c.is_transfer_class, false) = false
      AND t.created_at >= ($2::timestamptz - interval '14 days')
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT 50
  `, [threshold, now.toISOString()]);

  const sourceKeys = txns.map(txn => `txn:${txn.id}`);
  const states = await loadEventStates(pool, 'large_expense', subscribers.map(row => row.member_id), sourceKeys);
  const openUrl = buildOpenUrl(config.notification_base_url, 'transactions.html');
  const candidates = [];

  for (const txn of txns) {
    const sourceKey = `txn:${txn.id}`;
    const merchant = txn.merchant_name || txn.name || 'Large expense';
    for (const subscriber of subscribers) {
      const state = states.get(`${subscriber.member_id}:${sourceKey}`);
      if (!stateAllowsSend(state, now)) continue;
      candidates.push({
        member_id: subscriber.member_id,
        target_secret: subscriber.target_secret,
        event_type: 'large_expense',
        source_key: sourceKey,
        payload: {
          title: withAppTitle('Large expense recorded'),
          body: `${merchant} posted for ${formatMoney(txn.amount)}${txn.category_name ? ` in ${txn.category_name}` : ''}.`,
          open_url: openUrl,
          interruption_level: config.notification_default_interruption_level
        }
      });
    }
  }

  return candidates;
}

async function buildSyncIssueCandidates({ pool, config, byEvent, now }) {
  const subscribers = byEvent.get('sync_issue') || [];
  if (!subscribers.length) return [];

  const { rows: items } = await pool.query(`
    SELECT id, item_id, institution_name, status, error_code, updated_at
    FROM items
    WHERE status IN ('needs_reauth', 'sync_error')
      AND item_id <> 'monarch-import'
    ORDER BY institution_name NULLS LAST, id
  `);

  const sourceKeys = items.map(item => `item:${item.id}:${item.status}:${item.error_code || 'unknown'}`);
  const states = await loadEventStates(pool, 'sync_issue', subscribers.map(row => row.member_id), sourceKeys);
  const openUrl = buildOpenUrl(config.notification_base_url, 'settings.html');
  const candidates = [];

  for (const item of items) {
    const sourceKey = `item:${item.id}:${item.status}:${item.error_code || 'unknown'}`;
    const institution = item.institution_name || 'Linked institution';
    for (const subscriber of subscribers) {
      const state = states.get(`${subscriber.member_id}:${sourceKey}`);
      if (!stateAllowsSend(state, now, { repeatable: true })) continue;
      candidates.push({
        member_id: subscriber.member_id,
        target_secret: subscriber.target_secret,
        event_type: 'sync_issue',
        source_key: sourceKey,
        cooldown_hours: 12,
        payload: {
          title: withAppTitle(item.status === 'needs_reauth' ? 'Plaid account needs attention' : 'Sync issue detected'),
          body: item.status === 'needs_reauth'
            ? `${institution} needs to be re-linked in Pulse.`
            : `${institution} hit a Plaid sync error${item.error_code ? ` (${item.error_code})` : ''}.`,
          open_url: openUrl,
          interruption_level: config.notification_default_interruption_level
        }
      });
    }
  }

  return candidates;
}

async function buildBudgetOverrunCandidates({ pool, config, byEvent, now }) {
  const subscribers = byEvent.get('budget_overrun') || [];
  if (!subscribers.length) return [];

  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thresholdPct = parseConfigNumber(config.budget_overrun_threshold_pct, 15);
  const summary = await getMonthlyBudgetSummary(period);
  const overruns = summary.categories.filter(category => (
    category.budgeted > 0 &&
    category.spent >= (category.budgeted * (1 + thresholdPct / 100))
  ));

  const sourceKeys = overruns.map(category => `budget:${period}:category:${category.id}`);
  const states = await loadEventStates(pool, 'budget_overrun', subscribers.map(row => row.member_id), sourceKeys);
  const openUrl = buildOpenUrl(config.notification_base_url, 'budget.html');
  const candidates = [];

  for (const category of overruns) {
    const sourceKey = `budget:${period}:category:${category.id}`;
    const overPct = Math.round(((category.spent / category.budgeted) - 1) * 100);
    for (const subscriber of subscribers) {
      const state = states.get(`${subscriber.member_id}:${sourceKey}`);
      if (!stateAllowsSend(state, now)) continue;
      candidates.push({
        member_id: subscriber.member_id,
        target_secret: subscriber.target_secret,
        event_type: 'budget_overrun',
        source_key: sourceKey,
        payload: {
          title: withAppTitle('Budget overrun'),
          body: `${category.name} is ${overPct}% over budget this month (${formatMoney(category.spent)} vs ${formatMoney(category.budgeted)}).`,
          open_url: openUrl,
          interruption_level: config.notification_default_interruption_level
        }
      });
    }
  }

  return candidates;
}


async function buildRecurringAlertCandidates({ pool, config, byEvent, now }) {
  const eventTypes = ['recurring_price_creep', 'recurring_missed_income', 'recurring_new_commitment'];
  const activeEventTypes = eventTypes.filter(eventType => (byEvent.get(eventType) || []).length > 0);
  if (!activeEventTypes.length) return [];

  const { rows: alerts } = await pool.query(`
    SELECT id, recurring_expense_id, event_type, source_key, title, message, payload_json, occurred_on
    FROM recurring_alert_events
    WHERE dismissed_at IS NULL
      AND event_type = ANY($1::text[])
    ORDER BY occurred_on DESC, id DESC
    LIMIT 100
  `, [activeEventTypes]);
  if (!alerts.length) return [];

  const allCandidates = [];
  const openUrl = buildOpenUrl(config.notification_base_url, 'recurring.html');
  for (const eventType of activeEventTypes) {
    const subscribers = byEvent.get(eventType) || [];
    const eventAlerts = alerts.filter(alert => alert.event_type === eventType);
    const states = await loadEventStates(
      pool,
      eventType,
      subscribers.map(row => row.member_id),
      eventAlerts.map(alert => alert.source_key)
    );

    for (const alert of eventAlerts) {
      for (const subscriber of subscribers) {
        const state = states.get(`${subscriber.member_id}:${alert.source_key}`);
        if (!stateAllowsSend(state, now)) continue;
        allCandidates.push({
          member_id: subscriber.member_id,
          target_secret: subscriber.target_secret,
          event_type: eventType,
          source_key: alert.source_key,
          payload: {
            title: withAppTitle(alert.title),
            body: alert.message,
            open_url: openUrl,
            interruption_level: eventType === 'recurring_missed_income'
              ? 'time-sensitive'
              : config.notification_default_interruption_level
          }
        });
      }
    }
  }

  return allCandidates;
}

async function evaluateNotificationCandidates({ pool, cfg, now = new Date() }) {
  const config = await getNotificationConfig(cfg);
  const byEvent = await loadSubscribedMembers(pool);
  const eventCandidates = await Promise.all([
    buildLargeExpenseCandidates({ pool, config, byEvent, now }),
    buildSyncIssueCandidates({ pool, config, byEvent, now }),
    buildBudgetOverrunCandidates({ pool, config, byEvent, now }),
    buildRecurringAlertCandidates({ pool, config, byEvent, now })
  ]);

  return eventCandidates.flat();
}

module.exports = {
  ALLOWED_INTERRUPTION_LEVELS,
  DEFAULT_CONFIG,
  EVENT_TYPES,
  EVENT_TYPE_KEYS,
  GLOBAL_CONFIG_KEYS,
  buildOpenUrl,
  evaluateNotificationCandidates,
  getNotificationConfig,
  normalizeNotificationSubscriptions,
  validateNotificationConfigValue
};
