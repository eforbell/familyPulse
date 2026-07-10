'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { evaluateNotificationCandidates } = require('../lib/notification-rules');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PREFIX = 'test-notify-phase2';
let parentId;
let itemId;
let accountId;
let groceriesId;

async function cfg(key) {
  const values = {
    notifications_enabled: 'true',
    notification_base_url: 'https://pulse.example.test',
    notification_default_interruption_level: 'active',
    large_expense_threshold: '1000',
    budget_overrun_threshold_pct: '15',
    price_creep_threshold_pct: '5'
  };
  return values[key] ?? null;
}

before(async () => {
  const { rows } = await pool.query("SELECT id FROM family_members WHERE name = 'Alex' LIMIT 1");
  parentId = rows[0].id;

  const itemRes = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_name, status)
    VALUES ('access-token-notify', $1, 'Notification Test Bank', 'good')
    ON CONFLICT (item_id) DO UPDATE SET institution_name = EXCLUDED.institution_name
    RETURNING id
  `, [`${PREFIX}-item`]);
  itemId = itemRes.rows[0].id;

  const accountRes = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance)
    VALUES ($1, $2, 'Checking', 'depository', 'checking', '4455', 5000, 5000)
    ON CONFLICT (plaid_account_id) DO UPDATE SET item_id = EXCLUDED.item_id
    RETURNING id
  `, [`${PREFIX}-acct`, itemId]);
  accountId = accountRes.rows[0].id;

  const categoryRes = await pool.query("SELECT id FROM categories WHERE name = 'Groceries' LIMIT 1");
  groceriesId = categoryRes.rows[0].id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM notification_delivery_log WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM notification_event_state WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM member_notification_subscriptions WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM member_notification_channels WHERE member_id = $1', [parentId]);
  await pool.query("DELETE FROM recurring_alert_events WHERE source_key LIKE $1", [`${PREFIX}:%`]);
  await pool.query("DELETE FROM recurring_expenses WHERE merchant_key LIKE $1", [`${PREFIX}-%`]);
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE $1", [`${PREFIX}-%`]);

  await pool.query(`
    INSERT INTO member_notification_channels (member_id, channel_type, target_secret, enabled)
    VALUES ($1, 'brrr', 'https://api.brrr.now/v1/test-secret-phase2', true)
    ON CONFLICT (member_id, channel_type)
    DO UPDATE SET target_secret = EXCLUDED.target_secret, enabled = EXCLUDED.enabled, updated_at = now()
  `, [parentId]);
});

after(async () => {
  await pool.query("DELETE FROM recurring_alert_events WHERE source_key LIKE $1", [`${PREFIX}:%`]);
  await pool.query("DELETE FROM recurring_expenses WHERE merchant_key LIKE $1", [`${PREFIX}-%`]);
  await pool.query("DELETE FROM recurring_alert_events WHERE source_key LIKE $1", [`${PREFIX}:%`]);
  await pool.query("DELETE FROM recurring_expenses WHERE merchant_key LIKE $1", [`${PREFIX}-%`]);
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE $1", [`${PREFIX}-%`]);
  await pool.query('DELETE FROM notification_delivery_log WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM notification_event_state WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM member_notification_subscriptions WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM member_notification_channels WHERE member_id = $1', [parentId]);
  await pool.query('DELETE FROM accounts WHERE plaid_account_id = $1', [`${PREFIX}-acct`]);
  await pool.query('DELETE FROM items WHERE item_id = $1', [`${PREFIX}-item`]);
  await pool.end();
});

describe('notification phase 2 rules', () => {
  it('emits large expense candidates once per transaction', async () => {
    await pool.query(`
      INSERT INTO member_notification_subscriptions (member_id, event_type, enabled)
      VALUES ($1, 'large_expense', true)
      ON CONFLICT (member_id, event_type) DO UPDATE SET enabled = true, updated_at = now()
    `, [parentId]);

    const now = new Date();
    const txnRes = await pool.query(`
      INSERT INTO transactions (
        plaid_transaction_id, account_id, amount, date, merchant_name, name, category_id, pending, is_transfer, source
      )
      VALUES ($1, $2, 1288.42, $3, 'Costco Wholesale', 'Costco Wholesale', $4, false, false, 'plaid')
      RETURNING id
    `, [`${PREFIX}-large`, accountId, now.toISOString().slice(0, 10), groceriesId]);

    const candidates = await evaluateNotificationCandidates({ pool, cfg, now });
    const largeExpense = candidates.find(candidate => candidate.event_type === 'large_expense');
    assert.ok(largeExpense);
    assert.equal(largeExpense.member_id, parentId);
    assert.equal(largeExpense.source_key, `txn:${txnRes.rows[0].id}`);
    assert.equal(largeExpense.payload.title, 'Family Pulse: Large expense recorded');
    assert.match(largeExpense.payload.body, /\$1,288\.42/);

    await pool.query(`
      INSERT INTO notification_event_state (member_id, event_type, source_key, last_sent_at, last_result)
      VALUES ($1, 'large_expense', $2, now(), 'sent')
    `, [parentId, largeExpense.source_key]);

    const afterState = await evaluateNotificationCandidates({ pool, cfg, now });
    assert.equal(afterState.some(candidate => candidate.source_key === largeExpense.source_key), false);
  });

  it('emits sync issue candidates only after cooldown expires', async () => {
    await pool.query(`
      INSERT INTO member_notification_subscriptions (member_id, event_type, enabled)
      VALUES ($1, 'sync_issue', true)
      ON CONFLICT (member_id, event_type) DO UPDATE SET enabled = true, updated_at = now()
    `, [parentId]);

    await pool.query(
      "UPDATE items SET status = 'needs_reauth', error_code = 'ITEM_LOGIN_REQUIRED', updated_at = now() WHERE id = $1",
      [itemId]
    );

    const sourceKey = `item:${itemId}:needs_reauth:ITEM_LOGIN_REQUIRED`;
    await pool.query(`
      INSERT INTO notification_event_state (member_id, event_type, source_key, last_sent_at, cooldown_until, last_result)
      VALUES ($1, 'sync_issue', $2, now(), now() + interval '6 hours', 'sent')
    `, [parentId, sourceKey]);

    const blocked = await evaluateNotificationCandidates({ pool, cfg, now: new Date() });
    assert.equal(blocked.some(candidate => candidate.source_key === sourceKey), false);

    await pool.query(`
      UPDATE notification_event_state
      SET cooldown_until = now() - interval '1 minute'
      WHERE member_id = $1 AND event_type = 'sync_issue' AND source_key = $2
    `, [parentId, sourceKey]);

    const allowed = await evaluateNotificationCandidates({ pool, cfg, now: new Date() });
    const syncIssue = allowed.find(candidate => candidate.source_key === sourceKey);
    assert.ok(syncIssue);
    assert.equal(syncIssue.cooldown_hours, 12);
    assert.equal(syncIssue.payload.title, 'Family Pulse: Plaid account needs attention');
  });

  it('emits budget overrun candidates once per category per month', async () => {
    await pool.query(`
      INSERT INTO member_notification_subscriptions (member_id, event_type, enabled)
      VALUES ($1, 'budget_overrun', true)
      ON CONFLICT (member_id, event_type) DO UPDATE SET enabled = true, updated_at = now()
    `, [parentId]);

    await pool.query('UPDATE categories SET budget_amount = 200 WHERE id = $1', [groceriesId]);

    const now = new Date();
    const currentDate = now.toISOString().slice(0, 10);
    await pool.query(`
      INSERT INTO transactions (
        plaid_transaction_id, account_id, amount, date, merchant_name, name, category_id, pending, is_transfer, source
      )
      VALUES
        ($1, $2, 150.00, $3, 'Whole Foods', 'Whole Foods', $4, false, false, 'plaid'),
        ($5, $2, 90.00, $3, 'Trader Joe''s', 'Trader Joe''s', $4, false, false, 'plaid')
    `, [`${PREFIX}-budget-1`, accountId, currentDate, groceriesId, `${PREFIX}-budget-2`]);

    const candidates = await evaluateNotificationCandidates({ pool, cfg, now });
    const budgetOverrun = candidates.find(candidate => candidate.event_type === 'budget_overrun');
    assert.ok(budgetOverrun);
    assert.equal(budgetOverrun.source_key, `${`budget:${currentDate.slice(0, 7)}:category:${groceriesId}`}`);
    assert.equal(budgetOverrun.payload.title, 'Family Pulse: Budget overrun');
    assert.match(budgetOverrun.payload.body, /20% over budget/);

    await pool.query(`
      INSERT INTO notification_event_state (member_id, event_type, source_key, last_sent_at, last_result)
      VALUES ($1, 'budget_overrun', $2, now(), 'sent')
    `, [parentId, budgetOverrun.source_key]);

    const afterState = await evaluateNotificationCandidates({ pool, cfg, now });
    assert.equal(afterState.some(candidate => candidate.source_key === budgetOverrun.source_key), false);
  });

  it('emits recurring health alert candidates from persisted alert events', async () => {
    await pool.query(`
      INSERT INTO member_notification_subscriptions (member_id, event_type, enabled)
      VALUES ($1, 'recurring_price_creep', true)
      ON CONFLICT (member_id, event_type) DO UPDATE SET enabled = true, updated_at = now()
    `, [parentId]);

    const { rows: [stream] } = await pool.query(`
      INSERT INTO recurring_expenses (
        merchant_key, merchant_name, cashflow_type, frequency, confidence, status,
        latest_account_id, latest_amount, prior_amount, price_change_pct, price_change_direction,
        price_change_date, first_seen_date, last_seen_date, expected_next_date, interval_days,
        tolerance_days, source_txn_count
      )
      VALUES ($1, 'StreamBox', 'expense', 'monthly', 'high', 'active', $2, 21.00, 19.00, 10.53, 'up',
        '2026-07-01', '2026-03-01', '2026-07-01', '2026-08-01', 30, 3, 5)
      RETURNING id
    `, [`${PREFIX}-streambox`, accountId]);

    await pool.query(`
      INSERT INTO recurring_alert_events (recurring_expense_id, event_type, source_key, title, message, payload_json, occurred_on)
      VALUES ($1, 'recurring_price_creep', $2, 'Recurring price increase', 'StreamBox increased 11% to $21.00.', '{}'::jsonb, '2026-07-01')
    `, [stream.id, `${PREFIX}:price:${stream.id}`]);

    const candidates = await evaluateNotificationCandidates({ pool, cfg, now: new Date('2026-07-10T12:00:00Z') });
    const recurring = candidates.find(candidate => candidate.event_type === 'recurring_price_creep');
    assert.ok(recurring);
    assert.equal(recurring.member_id, parentId);
    assert.equal(recurring.source_key, `${PREFIX}:price:${stream.id}`);
    assert.equal(recurring.payload.title, 'Family Pulse: Recurring price increase');
    assert.equal(recurring.payload.open_url, 'https://pulse.example.test/recurring.html');

    await pool.query(`
      INSERT INTO notification_event_state (member_id, event_type, source_key, last_sent_at, last_result)
      VALUES ($1, 'recurring_price_creep', $2, now(), 'sent')
    `, [parentId, recurring.source_key]);

    const afterState = await evaluateNotificationCandidates({ pool, cfg, now: new Date('2026-07-10T12:00:00Z') });
    assert.equal(afterState.some(candidate => candidate.source_key === recurring.source_key), false);
  });

});
