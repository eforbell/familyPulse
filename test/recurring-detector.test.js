'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeRecurringGroup,
  detectRecurringCandidates,
  getRecurringConfig,
  inferScheduleAnchor,
  computeExpectedNextDate,
  determineStatus,
  monthlyEquivalent
} = require('../lib/recurring-detector');

function tx(id, amount, date, merchant, extra = {}) {
  return {
    id,
    account_id: extra.account_id || 1,
    amount,
    date,
    merchant_name: merchant,
    name: merchant,
    pending: false,
    is_transfer: false,
    is_hidden: false,
    transfer_type: null,
    is_transfer_class: false,
    ...extra
  };
}

describe('recurring-detector', () => {
  it('detects a monthly recurring expense with a day-of-month anchor', () => {
    const candidate = analyzeRecurringGroup([
      tx(1, 15.49, '2026-01-05', 'NETFLIX.COM/111111'),
      tx(2, 15.49, '2026-02-05', 'NETFLIX.COM/222222'),
      tx(3, 15.49, '2026-03-05', 'NETFLIX.COM/333333'),
      tx(4, 15.49, '2026-04-05', 'NETFLIX.COM/444444')
    ], { asOfDate: '2026-04-10' });

    assert.ok(candidate);
    assert.equal(candidate.cashflow_type, 'expense');
    assert.equal(candidate.frequency, 'monthly');
    assert.equal(candidate.schedule_anchor_type, 'day_of_month');
    assert.equal(candidate.schedule_anchor_value, '5');
    assert.equal(candidate.expected_next_date, '2026-05-05');
    assert.equal(candidate.status, 'active');
    assert.equal(candidate.confidence, 'high');
  });

  it('detects a biweekly recurring income stream separately from expenses', () => {
    const results = detectRecurringCandidates([
      tx(10, -2500.00, '2026-01-09', 'ACME PAYROLL'),
      tx(11, -2500.00, '2026-01-23', 'ACME PAYROLL'),
      tx(12, -2500.00, '2026-02-06', 'ACME PAYROLL'),
      tx(13, -2500.00, '2026-02-20', 'ACME PAYROLL'),
      tx(14, 89.99, '2026-01-10', 'SPOTIFY USA LLC'),
      tx(15, 89.99, '2026-02-10', 'SPOTIFY USA LLC'),
      tx(16, 89.99, '2026-03-10', 'SPOTIFY USA LLC')
    ], { asOfDate: '2026-03-15' });

    assert.equal(results.length, 2);
    const income = results.find(item => item.cashflow_type === 'income');
    const expense = results.find(item => item.cashflow_type === 'expense');
    assert.ok(income);
    assert.ok(expense);
    assert.equal(income.frequency, 'biweekly');
    assert.equal(expense.frequency, 'monthly');
  });

  it('reads lastDetectionAt from the cfg callback path', async () => {
    const values = {
      recurring_amount_tolerance_pct: '15',
      recurring_lookback_months: '12',
      recurring_last_detection_at: '2026-03-22T10:15:00.000Z'
    };
    const config = await getRecurringConfig(async key => values[key]);
    assert.equal(config.amountTolerancePct, 0.15);
    assert.equal(config.lookbackMonths, 12);
    assert.equal(config.lastDetectionAt, '2026-03-22T10:15:00.000Z');
  });

  it('rejects irregular repeat purchases as non-recurring', () => {
    const candidate = analyzeRecurringGroup([
      tx(20, 42.10, '2026-01-02', 'AMAZON'),
      tx(21, 17.44, '2026-01-19', 'AMAZON'),
      tx(22, 91.21, '2026-02-13', 'AMAZON')
    ], { asOfDate: '2026-02-20' });

    assert.equal(candidate, null);
  });

  it('marks stale and likely_cancelled items based on elapsed expected intervals', () => {
    const stale = determineStatus(new Date('2026-01-01T00:00:00Z'), 30, new Date('2026-03-10T00:00:00Z'));
    const cancelled = determineStatus(new Date('2026-01-01T00:00:00Z'), 30, new Date('2026-05-15T00:00:00Z'));
    assert.equal(stale, 'stale');
    assert.equal(cancelled, 'likely_cancelled');
  });

  it('tracks price changes while preserving the recurring match', () => {
    const candidate = analyzeRecurringGroup([
      tx(30, 15.49, '2026-01-05', 'NETFLIX.COM/111111'),
      tx(31, 15.49, '2026-02-05', 'NETFLIX.COM/222222'),
      tx(32, 22.99, '2026-03-05', 'NETFLIX.COM/333333'),
      tx(33, 22.99, '2026-04-05', 'NETFLIX.COM/444444')
    ], { asOfDate: '2026-04-10' });

    assert.ok(candidate);
    assert.equal(candidate.frequency, 'monthly');
    assert.equal(candidate.latest_amount, 22.99);
    assert.equal(candidate.prior_amount, 22.99);
    assert.equal(candidate.price_change_pct, 0);
  });

  it('infers last-day-of-month anchors and projects the next date accordingly', () => {
    const anchor = inferScheduleAnchor([
      new Date('2025-01-31T00:00:00Z'),
      new Date('2025-02-28T00:00:00Z'),
      new Date('2025-03-31T00:00:00Z')
    ], 'monthly');
    assert.equal(anchor.schedule_anchor_type, 'last_day_of_month');
    assert.equal(anchor.schedule_anchor_value, 'last');

    const next = computeExpectedNextDate(
      new Date('2025-03-31T00:00:00Z'),
      'monthly',
      anchor.schedule_anchor_type,
      anchor.schedule_anchor_value
    );
    assert.equal(next.toISOString().slice(0, 10), '2025-04-30');
  });

  it('excludes transfer-like flows from expense recurrence detection', () => {
    const candidate = analyzeRecurringGroup([
      tx(40, 500.00, '2026-01-10', 'PAYMENT THANK YOU', { transfer_type: 'cc_payment' }),
      tx(41, 500.00, '2026-02-10', 'PAYMENT THANK YOU', { transfer_type: 'cc_payment' }),
      tx(42, 500.00, '2026-03-10', 'PAYMENT THANK YOU', { transfer_type: 'cc_payment' })
    ], { asOfDate: '2026-03-15' });

    assert.equal(candidate, null);
  });

  it('detects a multi-beneficiary same-day income stream (e.g. Social Security)', () => {
    // Primary + two child beneficiaries all paid on the same day each month.
    // SSA pays on a weekday schedule, so the day-of-month drifts (15th, 20th, 17th).
    const results = detectRecurringCandidates([
      tx(1, -771.00, '2026-04-15', 'Social Security Administration'),
      tx(2, -771.00, '2026-04-15', 'Social Security Administration'),
      tx(3, -3084.00, '2026-04-15', 'Social Security Administration'),
      tx(4, -771.00, '2026-05-20', 'Social Security Administration'),
      tx(5, -771.00, '2026-05-20', 'Social Security Administration'),
      tx(6, -3084.00, '2026-05-20', 'Social Security Administration'),
      tx(7, -3084.00, '2026-06-17', 'Social Security Administration'),
      tx(8, -771.00, '2026-06-17', 'Social Security Administration'),
      tx(9, -771.00, '2026-06-17', 'Social Security Administration')
    ], { asOfDate: '2026-06-18' });

    assert.equal(results.length, 1);
    const income = results[0];
    assert.equal(income.cashflow_type, 'income');
    assert.equal(income.frequency, 'monthly');
    assert.equal(income.status, 'active');
    // All same-day beneficiaries fold into one monthly occurrence: 3084 + 771 + 771.
    assert.equal(income.latest_amount, 4626);
  });

  it('detects weekday-anchored monthly income with a 35-day leg amid retro lumps and a pending latest', () => {
    // Weekday-anchored benefit income (Nth-weekday cadence -> Apr 8 to May 13 = 35 days),
    // paid to a primary + two equal secondary beneficiaries on the same day. Includes
    // retroactive back-pay lump sums that must be ignored, and the latest month's primary
    // leg still pending (excluded from the candidate set until it posts).
    const results = detectRecurringCandidates([
      tx(7001, -28000.00, '2026-03-04', 'Regional Benefits Agency'), // one-off back-pay lump
      tx(7002, -6400.00, '2026-03-09', 'Regional Benefits Agency'), // retro lump
      tx(7003, -6400.00, '2026-03-09', 'Regional Benefits Agency'), // retro lump
      tx(7101, -640.00, '2026-04-08', 'Regional Benefits Agency'),
      tx(7102, -640.00, '2026-04-08', 'Regional Benefits Agency'),
      tx(7103, -2400.00, '2026-04-08', 'Regional Benefits Agency'),
      tx(7204, -640.00, '2026-05-13', 'Regional Benefits Agency'),
      tx(7205, -640.00, '2026-05-13', 'Regional Benefits Agency'),
      tx(7206, -2400.00, '2026-05-13', 'Regional Benefits Agency'),
      tx(7307, -2400.00, '2026-06-10', 'Regional Benefits Agency', { pending: true }),
      tx(7308, -640.00, '2026-06-10', 'Regional Benefits Agency'),
      tx(7309, -640.00, '2026-06-10', 'Regional Benefits Agency')
    ], { asOfDate: '2026-06-18' });

    assert.equal(results.length, 1);
    assert.equal(results[0].cashflow_type, 'income');
    assert.equal(results[0].frequency, 'monthly');
    assert.equal(results[0].latest_amount, 3680); // 640 + 640 + 2400 (full April/May month)
    assert.equal(results[0].status, 'active');
  });

  it('does not let a one-off same-day charge break a clean monthly stream', () => {
    const candidate = analyzeRecurringGroup([
      tx(1, 50.00, '2026-01-01', 'GYM'),
      tx(2, 50.00, '2026-02-01', 'GYM'),
      tx(3, 30.00, '2026-02-01', 'GYM'), // one-off same-day noise, not a recurring band
      tx(4, 50.00, '2026-03-01', 'GYM')
    ], { asOfDate: '2026-03-05' });

    assert.ok(candidate);
    assert.equal(candidate.frequency, 'monthly');
    assert.equal(candidate.latest_amount, 50);
  });

  it('converts supported frequencies to monthly equivalents', () => {
    assert.equal(monthlyEquivalent(100, 'weekly'), 433);
    assert.equal(monthlyEquivalent(100, 'biweekly'), 217);
    assert.equal(monthlyEquivalent(300, 'quarterly'), 100);
    assert.equal(monthlyEquivalent(1200, 'annual'), 100);
  });
});
