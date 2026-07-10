'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMissedIncomeEvent,
  buildNewCommitmentEvent,
  buildPriceCreepEvent,
  buildRecurringAlertEvents,
  resolveInactiveMissedIncomeAlerts
} = require('../lib/recurring-alerts');

const baseExpense = {
  id: 42,
  merchant_name: 'StreamBox',
  cashflow_type: 'expense',
  frequency: 'monthly',
  confidence: 'high',
  status: 'active',
  latest_amount: 21,
  prior_amount: 19,
  price_change_pct: 10.53,
  price_change_direction: 'up',
  price_change_date: '2026-07-01',
  first_seen_date: '2026-03-01',
  last_seen_date: '2026-07-01',
  expected_next_date: '2026-08-01',
  tolerance_days: 3
};

describe('recurring health alert event rules', () => {
  it('emits price creep only at or above threshold for active expenses', () => {
    const event = buildPriceCreepEvent(baseExpense, { thresholdPct: 5 });
    assert.equal(event.event_type, 'recurring_price_creep');
    assert.equal(event.source_key, 'recurring:42:price:2026-07-01');
    assert.match(event.message, /increased 11%/);

    assert.equal(buildPriceCreepEvent({ ...baseExpense, price_change_pct: 4.9 }, { thresholdPct: 5 }), null);
    assert.equal(buildPriceCreepEvent({ ...baseExpense, status: 'ignored' }, { thresholdPct: 5 }), null);
    assert.equal(buildPriceCreepEvent({ ...baseExpense, cashflow_type: 'income' }, { thresholdPct: 5 }), null);
  });

  it('emits missed income after expected date plus tolerance', () => {
    const income = {
      id: 7,
      merchant_name: 'ACME Payroll',
      cashflow_type: 'income',
      frequency: 'biweekly',
      confidence: 'high',
      status: 'active',
      latest_amount: 2500,
      expected_next_date: '2026-07-05',
      tolerance_days: 2
    };

    assert.equal(buildMissedIncomeEvent(income, { asOfDate: '2026-07-07' }), null);
    const event = buildMissedIncomeEvent(income, { asOfDate: '2026-07-08' });
    assert.equal(event.event_type, 'recurring_missed_income');
    assert.equal(event.source_key, 'recurring:7:missed-income:2026-07-05');
    assert.equal(event.payload.days_late, 1);
  });

  it('emits new commitment only for post-high-water medium/high expenses', () => {
    assert.equal(buildNewCommitmentEvent(baseExpense, { highWaterId: 100 }), null);
    assert.equal(buildNewCommitmentEvent({ ...baseExpense, confidence: 'low' }, { highWaterId: 1 }), null);
    assert.equal(buildNewCommitmentEvent({ ...baseExpense, cashflow_type: 'income' }, { highWaterId: 1 }), null);

    const event = buildNewCommitmentEvent(baseExpense, { highWaterId: 1 });
    assert.equal(event.event_type, 'recurring_new_commitment');
    assert.equal(event.source_key, 'recurring:42:new-commitment');
  });

  it('combines independent alert rules for streams', () => {
    const events = buildRecurringAlertEvents([baseExpense], {
      thresholdPct: 5,
      highWaterId: 1,
      asOfDate: '2026-07-10'
    });
    assert.deepEqual(events.map(event => event.event_type).sort(), [
      'recurring_new_commitment',
      'recurring_price_creep'
    ]);
  });

  it('auto-resolves missed income alerts that are no longer active', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
    };

    await resolveInactiveMissedIncomeAlerts(client, [{
      event_type: 'recurring_missed_income',
      source_key: 'recurring:7:missed-income:2026-07-19'
    }]);

    assert.equal(queries.length, 1);
    assert.ok(String(queries[0].sql).includes("event_type = 'recurring_missed_income'"));
    assert.ok(String(queries[0].sql).includes('source_key <> ALL'));
    assert.deepEqual(queries[0].params, [['recurring:7:missed-income:2026-07-19']]);

    queries.length = 0;
    await resolveInactiveMissedIncomeAlerts(client, []);
    assert.equal(queries.length, 1);
    assert.ok(String(queries[0].sql).includes('dismissed_at IS NULL'));
    assert.equal(queries[0].params, undefined);
  });

});
