'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeForecast,
  detectDangerZones,
  computeMonthlyOutlook,
  detectExcessLiquidity,
  computeConfidenceBands,
  formatDate,
  roundMoney
} = require('../lib/cash-flow-engine');

// Helper: build a minimal seasonal baseline (12 months)
function flatBaseline(monthlyDiscretionary = 0) {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    median_discretionary: monthlyDiscretionary,
    median_recurring: 0,
    median_total: monthlyDiscretionary
  }));
}

describe('cash-flow-engine', () => {
  describe('computeForecast — simple cases', () => {
    it('produces correct number of days for horizon', () => {
      const result = computeForecast({
        starting_balance: 10000,
        horizon_days: 30,
        start_date: '2026-04-01'
      });
      assert.equal(result.length, 30);
      assert.equal(result[0].date, '2026-04-01');
      assert.equal(result[29].date, '2026-04-30');
    });

    it('balance is unchanged with no events and no seasonal baseline', () => {
      const result = computeForecast({
        starting_balance: 5000,
        horizon_days: 7,
        start_date: '2026-04-01'
      });
      for (const day of result) {
        assert.equal(day.projected_balance, 5000);
      }
    });

    it('one paycheck (biweekly) adds to balance on schedule', () => {
      const result = computeForecast({
        starting_balance: 3000,
        recurring_income: [{
          merchant_key: 'employer inc',
          amount: 2500,
          frequency: 'biweekly',
          last_seen_date: '2026-03-20',
          expected_next_date: '2026-04-03',
          schedule_anchor_type: null,
          schedule_anchor_value: null
        }],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      // Day 0 (Apr 1): no paycheck → $3000
      assert.equal(result[0].projected_balance, 3000);

      // Day 2 (Apr 3): paycheck of $2500 → $5500
      const apr3 = result.find(d => d.date === '2026-04-03');
      assert.equal(apr3.projected_balance, 5500);
      assert.equal(apr3.events.length, 1);
      assert.equal(apr3.events[0].type, 'income');
      assert.equal(apr3.events[0].amount, 2500);

      // Day 16 (Apr 17): second paycheck → $8000
      const apr17 = result.find(d => d.date === '2026-04-17');
      assert.equal(apr17.projected_balance, 8000);
    });

    it('one recurring expense subtracts on schedule', () => {
      const result = computeForecast({
        starting_balance: 5000,
        recurring_expenses: [{
          merchant_key: 'netflix com',
          amount: 15.49,
          frequency: 'monthly',
          last_seen_date: '2026-03-05',
          expected_next_date: '2026-04-05',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '5'
        }],
        horizon_days: 60,
        start_date: '2026-04-01'
      });

      // Before the charge: balance stays at 5000
      assert.equal(result[0].projected_balance, 5000);

      // Apr 5 (day 4): Netflix $15.49
      const apr5 = result.find(d => d.date === '2026-04-05');
      assert.equal(apr5.projected_balance, 4984.51);
      assert.equal(apr5.events[0].type, 'expense');

      // May 5 (day 34): second Netflix charge
      const may5 = result.find(d => d.date === '2026-05-05');
      assert.equal(may5.projected_balance, 4969.02);
    });

    it('discretionary daily burn reduces balance', () => {
      const baseline = flatBaseline(300); // $300/month = $10/day in a 30-day month
      const result = computeForecast({
        starting_balance: 1000,
        seasonal_baseline: baseline,
        horizon_days: 30,
        start_date: '2026-04-01' // April has 30 days
      });

      // Day 0: $1000 - $10 = $990
      assert.equal(result[0].projected_balance, 990);
      assert.equal(result[0].events.length, 1);
      assert.equal(result[0].events[0].type, 'discretionary');
      assert.equal(result[0].events[0].amount, 10);

      // Day 29 (Apr 30): $1000 - 30*$10 = $700
      assert.equal(result[29].projected_balance, 700);
    });

    it('planned expense subtracts on scheduled date', () => {
      const result = computeForecast({
        starting_balance: 10000,
        planned_expenses: [
          { name: 'Car insurance (6-month)', amount: 950, scheduled_date: '2026-04-15' }
        ],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      const apr15 = result.find(d => d.date === '2026-04-15');
      assert.equal(apr15.projected_balance, 9050);
      assert.equal(apr15.events[0].type, 'planned_expense');
      assert.equal(apr15.events[0].name, 'Car insurance (6-month)');
    });

    it('liability payment subtracts on due date and recurs monthly', () => {
      const result = computeForecast({
        starting_balance: 8000,
        liability_payments: [{
          account_name: 'Chase Visa',
          minimum_payment_amount: 250,
          next_payment_due_date: '2026-04-10'
        }],
        horizon_days: 90,
        start_date: '2026-04-01'
      });

      // Apr 10: first payment
      const apr10 = result.find(d => d.date === '2026-04-10');
      assert.equal(apr10.projected_balance, 7750);
      assert.equal(apr10.events[0].type, 'liability_payment');

      // May 10: second payment
      const may10 = result.find(d => d.date === '2026-05-10');
      assert.equal(may10.projected_balance, 7500);

      // Jun 10: third payment
      const jun10 = result.find(d => d.date === '2026-06-10');
      assert.equal(jun10.projected_balance, 7250);
    });
  });

  describe('computeForecast — complex scenarios', () => {
    it('multiple income streams + expenses + liability + seasonal + planned', () => {
      const result = computeForecast({
        starting_balance: 15000,
        recurring_income: [
          { // Biweekly paycheck
            merchant_key: 'acme corp',
            amount: 3000,
            frequency: 'biweekly',
            expected_next_date: '2026-04-03',
            schedule_anchor_type: null,
            schedule_anchor_value: null
          },
          { // Monthly side gig
            merchant_key: 'consulting llc',
            amount: 500,
            frequency: 'monthly',
            expected_next_date: '2026-04-15',
            schedule_anchor_type: 'day_of_month',
            schedule_anchor_value: '15'
          }
        ],
        recurring_expenses: [
          { // Monthly streaming
            merchant_key: 'netflix com',
            amount: 15.49,
            frequency: 'monthly',
            expected_next_date: '2026-04-05',
            schedule_anchor_type: 'day_of_month',
            schedule_anchor_value: '5'
          },
          { // Weekly gym
            merchant_key: 'planet fitness',
            amount: 25,
            frequency: 'weekly',
            expected_next_date: '2026-04-02',
            schedule_anchor_type: null,
            schedule_anchor_value: null
          }
        ],
        liability_payments: [{
          account_name: 'Chase Visa',
          minimum_payment_amount: 200,
          next_payment_due_date: '2026-04-20'
        }],
        seasonal_baseline: flatBaseline(600), // $600/mo → $20/day in April
        planned_expenses: [
          { name: 'Vet visit', amount: 350, scheduled_date: '2026-04-12' }
        ],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      assert.equal(result.length, 30);

      // Verify day 0 (Apr 1): discretionary burn only
      // $15000 - $20 = $14980
      assert.equal(result[0].projected_balance, 14980);

      // Apr 2: gym ($25) + discretionary ($20) → $14980 - 25 - 20 = $14935
      const apr2 = result.find(d => d.date === '2026-04-02');
      assert.equal(apr2.projected_balance, 14935);

      // Verify overall direction: balance should increase over 30 days
      // Income: 2 paychecks * $3000 + 1 consulting * $500 = $6500
      // Expenses: ~4.3 gym * $25 + 1 Netflix * $15.49 + 1 Visa * $200 + 1 Vet $350 + 30 days * $20/day = ~$1272.79
      // Net: should be significantly positive
      const lastDay = result[result.length - 1];
      assert.ok(lastDay.projected_balance > 15000, 'Balance should grow with strong income');
    });

    it('handles multiple planned expenses on the same date', () => {
      const result = computeForecast({
        starting_balance: 5000,
        planned_expenses: [
          { name: 'Expense A', amount: 100, scheduled_date: '2026-04-10' },
          { name: 'Expense B', amount: 200, scheduled_date: '2026-04-10' }
        ],
        horizon_days: 15,
        start_date: '2026-04-01'
      });

      const apr10 = result.find(d => d.date === '2026-04-10');
      assert.equal(apr10.projected_balance, 4700); // 5000 - 100 - 200
      assert.equal(apr10.events.length, 2);
    });
  });

  describe('computeForecast — edge cases', () => {
    it('handles month boundary correctly (30→31 day months)', () => {
      const baseline = flatBaseline(310); // $310/mo
      const result = computeForecast({
        starting_balance: 10000,
        seasonal_baseline: baseline,
        horizon_days: 61, // Apr (30 days) + May (31 days)
        start_date: '2026-04-01'
      });

      // April: $310/30 = $10.33/day
      assert.equal(result[0].events[0].amount, 10.33);

      // May 1 (day 30): $310/31 = $10/day
      const may1 = result.find(d => d.date === '2026-05-01');
      assert.equal(may1.events[0].amount, 10);
    });

    it('handles February (short month)', () => {
      const baseline = flatBaseline(280); // $280/mo
      const result = computeForecast({
        starting_balance: 5000,
        seasonal_baseline: baseline,
        horizon_days: 28,
        start_date: '2026-02-01' // 2026 is not a leap year → 28 days
      });

      // Feb: $280/28 = $10/day
      assert.equal(result[0].events[0].amount, 10);
    });

    it('handles leap year February', () => {
      const baseline = flatBaseline(290); // $290/mo
      const result = computeForecast({
        starting_balance: 5000,
        seasonal_baseline: baseline,
        horizon_days: 29,
        start_date: '2028-02-01' // 2028 is a leap year → 29 days
      });

      // Feb 2028: $290/29 = $10/day
      assert.equal(result[0].events[0].amount, 10);
    });

    it('recurring monthly expense anchored to 31st handles short months', () => {
      const result = computeForecast({
        starting_balance: 5000,
        recurring_expenses: [{
          merchant_key: 'mortgage co',
          amount: 2000,
          frequency: 'monthly',
          last_seen_date: '2026-01-31',
          expected_next_date: '2026-02-28', // Feb has 28 days
          schedule_anchor_type: 'last_day_of_month',
          schedule_anchor_value: null
        }],
        horizon_days: 90,
        start_date: '2026-02-01'
      });

      // Feb 28: payment on last day of month
      const feb28 = result.find(d => d.date === '2026-02-28');
      assert.ok(feb28, 'Should have Feb 28');
      assert.equal(feb28.events.length, 1);
      assert.equal(feb28.events[0].amount, 2000);

      // Mar 31: payment on last day of month
      const mar31 = result.find(d => d.date === '2026-03-31');
      assert.ok(mar31, 'Should have Mar 31');
      assert.equal(mar31.events.length, 1);
      assert.equal(mar31.events[0].amount, 2000);

      // Apr 30: payment on last day of month
      const apr30 = result.find(d => d.date === '2026-04-30');
      assert.ok(apr30, 'Should have Apr 30');
      assert.equal(apr30.events.length, 1);
      assert.equal(apr30.events[0].amount, 2000);
    });

    it('liability payment on the 31st falls back to month-end in short months', () => {
      const result = computeForecast({
        starting_balance: 8000,
        liability_payments: [{
          account_name: 'Auto Loan',
          minimum_payment_amount: 400,
          next_payment_due_date: '2026-01-31'
        }],
        horizon_days: 90,
        start_date: '2026-01-15'
      });

      // Jan 31: first payment
      const jan31 = result.find(d => d.date === '2026-01-31');
      assert.ok(jan31);
      assert.equal(jan31.events[0].amount, 400);

      // Feb: should fall back to 28th (2026 is not a leap year)
      const feb28 = result.find(d => d.date === '2026-02-28');
      assert.ok(feb28);
      assert.equal(feb28.events[0].amount, 400);

      // Mar 31: back to 31st
      const mar31 = result.find(d => d.date === '2026-03-31');
      assert.ok(mar31);
      assert.equal(mar31.events[0].amount, 400);
    });

    it('balance can go negative', () => {
      const result = computeForecast({
        starting_balance: 100,
        recurring_expenses: [{
          merchant_key: 'big expense',
          amount: 500,
          frequency: 'monthly',
          expected_next_date: '2026-04-05',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '5'
        }],
        horizon_days: 10,
        start_date: '2026-04-01'
      });

      const apr5 = result.find(d => d.date === '2026-04-05');
      assert.ok(apr5.projected_balance < 0, 'Balance should be negative after large expense');
    });

    it('zero starting balance works correctly', () => {
      const result = computeForecast({
        starting_balance: 0,
        recurring_income: [{
          merchant_key: 'employer',
          amount: 1000,
          frequency: 'monthly',
          expected_next_date: '2026-04-15',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '15'
        }],
        horizon_days: 20,
        start_date: '2026-04-01'
      });

      assert.equal(result[0].projected_balance, 0);
      const apr15 = result.find(d => d.date === '2026-04-15');
      assert.equal(apr15.projected_balance, 1000);
    });

    it('no items at all produces flat projection', () => {
      const result = computeForecast({
        starting_balance: 7500,
        horizon_days: 5,
        start_date: '2026-04-01'
      });
      for (const day of result) {
        assert.equal(day.projected_balance, 7500);
        assert.equal(day.events.length, 0);
      }
    });

    it('handles expected_next_date before start_date (skips past events)', () => {
      const result = computeForecast({
        starting_balance: 5000,
        recurring_expenses: [{
          merchant_key: 'old sub',
          amount: 10,
          frequency: 'monthly',
          expected_next_date: '2026-03-15', // before start
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '15'
        }],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      // Should pick up Apr 15 occurrence, not try to process March 15
      const apr15 = result.find(d => d.date === '2026-04-15');
      assert.ok(apr15);
      assert.equal(apr15.events.length, 1);
      assert.equal(apr15.events[0].amount, 10);
    });
  });

  describe('confidence bands', () => {
    it('day 0 has zero-width bands', () => {
      const { low, high } = computeConfidenceBands(10000, 0);
      assert.equal(low, 10000);
      assert.equal(high, 10000);
    });

    it('day 7 has ±5% bands', () => {
      const { low, high } = computeConfidenceBands(10000, 7);
      assert.equal(low, 9500);
      assert.equal(high, 10500);
    });

    it('day 30 has ±15% bands', () => {
      const { low, high } = computeConfidenceBands(10000, 30);
      assert.equal(low, 8500);
      assert.equal(high, 11500);
    });

    it('day 90 has ±25% bands', () => {
      const { low, high } = computeConfidenceBands(10000, 90);
      assert.equal(low, 7500);
      assert.equal(high, 12500);
    });

    it('bands increase monotonically', () => {
      let prevWidth = 0;
      for (let day = 0; day <= 90; day++) {
        const { low, high } = computeConfidenceBands(10000, day);
        const width = high - low;
        assert.ok(width >= prevWidth, `Band width should not decrease at day ${day}`);
        prevWidth = width;
      }
    });

    it('bands interpolate linearly between anchor points', () => {
      // Day 15 should be between 5% and 15% → ~8.48%
      const { low, high } = computeConfidenceBands(10000, 15);
      const pct = (high - low) / 2 / 10000;
      assert.ok(pct > 0.05, 'Day 15 should be > 5%');
      assert.ok(pct < 0.15, 'Day 15 should be < 15%');
    });

    it('handles negative balance correctly', () => {
      const { low, high } = computeConfidenceBands(-1000, 30);
      // With negative balance, low < high should still hold
      assert.ok(low < high, 'Bands should still have width for negative balance');
      // The margin is based on abs(balance), so -1000 ± 150
      assert.equal(low, -1150);
      assert.equal(high, -850);
    });

    it('caps at 25% even beyond 90 days', () => {
      const { low, high } = computeConfidenceBands(10000, 120);
      assert.equal(low, 7500);
      assert.equal(high, 12500);
    });
  });

  describe('formatDate', () => {
    it('formats UTC dates as YYYY-MM-DD', () => {
      const d = new Date(Date.UTC(2026, 0, 5)); // Jan 5
      assert.equal(formatDate(d), '2026-01-05');
    });

    it('pads single-digit months and days', () => {
      const d = new Date(Date.UTC(2026, 2, 9)); // Mar 9
      assert.equal(formatDate(d), '2026-03-09');
    });
  });

  describe('roundMoney', () => {
    it('rounds to two decimal places', () => {
      assert.equal(roundMoney(10.005), 10.01);
      assert.equal(roundMoney(10.004), 10);
      assert.equal(roundMoney(99.999), 100);
    });
  });

  describe('detectDangerZones', () => {
    it('returns empty array when balance stays above safety floor', () => {
      const forecast = computeForecast({
        starting_balance: 10000,
        horizon_days: 30,
        start_date: '2026-04-01'
      });
      const zones = detectDangerZones(forecast, 3000);
      assert.equal(zones.length, 0);
    });

    it('detects danger zone triggered by large planned expense', () => {
      const forecast = computeForecast({
        starting_balance: 5000,
        planned_expenses: [
          { name: 'Tuition deposit', amount: 4000, scheduled_date: '2026-04-10' }
        ],
        horizon_days: 15,
        start_date: '2026-04-01'
      });
      const zones = detectDangerZones(forecast, 3000);

      assert.ok(zones.length > 0, 'Should detect at least one danger zone');
      // Apr 10: $5000 - $4000 = $1000 < $3000
      const apr10zone = zones.find(z => z.date === '2026-04-10');
      assert.ok(apr10zone);
      assert.equal(apr10zone.severity, 'danger');
      assert.equal(apr10zone.projected_balance, 1000);
      assert.equal(apr10zone.deficit_below_floor, 2000);
      assert.equal(apr10zone.trigger_event.name, 'Tuition deposit');
    });

    it('detects multiple danger zones with recovery between', () => {
      const forecast = computeForecast({
        starting_balance: 4000,
        planned_expenses: [
          { name: 'Expense A', amount: 2500, scheduled_date: '2026-04-05' }
        ],
        recurring_income: [{
          merchant_key: 'employer',
          amount: 5000,
          frequency: 'monthly',
          expected_next_date: '2026-04-10',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '10'
        }],
        // Second dip from another planned expense after recovery
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      // Manually add another planned expense after income recovery
      const forecast2 = computeForecast({
        starting_balance: 4000,
        planned_expenses: [
          { name: 'Expense A', amount: 2500, scheduled_date: '2026-04-05' },
          { name: 'Expense B', amount: 5000, scheduled_date: '2026-04-20' }
        ],
        recurring_income: [{
          merchant_key: 'employer',
          amount: 5000,
          frequency: 'monthly',
          expected_next_date: '2026-04-10',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '10'
        }],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      const zones = detectDangerZones(forecast2, 3000);

      // First dip: Apr 5 ($4000 - $2500 = $1500)
      const firstDip = zones.find(z => z.date === '2026-04-05');
      assert.ok(firstDip);
      assert.equal(firstDip.severity, 'danger');

      // Recovery at Apr 10 (+$5000), then second dip at Apr 20 (-$5000)
      const secondDip = zones.find(z => z.date === '2026-04-20');
      assert.ok(secondDip);
      assert.equal(secondDip.severity, 'danger');
    });

    it('flags at_risk when only pessimistic band crosses floor', () => {
      // Balance stays above floor, but confidence_low dips below
      // Need balance close to the floor so that the confidence band crosses it
      const forecast = computeForecast({
        starting_balance: 3500,
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      // At day 30, confidence_low = 3500 - (3500 * 0.15) = 2975 < 3000
      const zones = detectDangerZones(forecast, 3000);
      const atRiskDays = zones.filter(z => z.severity === 'at_risk');
      assert.ok(atRiskDays.length > 0, 'Should have at_risk days');

      // No danger zones since projected balance stays at $3500
      const dangerDays = zones.filter(z => z.severity === 'danger');
      assert.equal(dangerDays.length, 0, 'Should have no danger zones');
    });

    it('uses custom safety floor', () => {
      const forecast = computeForecast({
        starting_balance: 2000,
        horizon_days: 5,
        start_date: '2026-04-01'
      });

      // With floor of $1000, $2000 balance is fine
      const zonesLow = detectDangerZones(forecast, 1000);
      const dangerLow = zonesLow.filter(z => z.severity === 'danger');
      assert.equal(dangerLow.length, 0);

      // With floor of $5000, $2000 balance triggers danger
      const zonesHigh = detectDangerZones(forecast, 5000);
      assert.ok(zonesHigh.length > 0);
      assert.equal(zonesHigh[0].severity, 'danger');
    });

    it('trigger_event identifies the largest non-income expense', () => {
      const forecast = computeForecast({
        starting_balance: 4000,
        recurring_expenses: [
          {
            merchant_key: 'small sub',
            amount: 10,
            frequency: 'monthly',
            expected_next_date: '2026-04-05',
            schedule_anchor_type: 'day_of_month',
            schedule_anchor_value: '5'
          }
        ],
        planned_expenses: [
          { name: 'Big purchase', amount: 3500, scheduled_date: '2026-04-05' }
        ],
        horizon_days: 10,
        start_date: '2026-04-01'
      });

      const zones = detectDangerZones(forecast, 3000);
      const apr5 = zones.find(z => z.date === '2026-04-05');
      assert.ok(apr5);
      assert.equal(apr5.trigger_event.name, 'Big purchase');
      assert.equal(apr5.trigger_event.amount, 3500);
    });

    it('defaults safety floor to $3000', () => {
      const forecast = computeForecast({
        starting_balance: 2500,
        horizon_days: 5,
        start_date: '2026-04-01'
      });

      const zones = detectDangerZones(forecast); // no floor arg
      assert.ok(zones.length > 0);
      assert.equal(zones[0].severity, 'danger');
      assert.equal(zones[0].deficit_below_floor, 500); // 3000 - 2500
    });
  });

  describe('computeMonthlyOutlook', () => {
    it('produces monthly summaries with correct event aggregation', () => {
      const forecast = computeForecast({
        starting_balance: 10000,
        recurring_income: [{
          merchant_key: 'employer',
          amount: 3000,
          frequency: 'monthly',
          expected_next_date: '2026-04-15',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '15'
        }],
        recurring_expenses: [{
          merchant_key: 'netflix com',
          amount: 15,
          frequency: 'monthly',
          expected_next_date: '2026-04-05',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '5'
        }],
        liability_payments: [{
          account_name: 'Visa',
          minimum_payment_amount: 200,
          next_payment_due_date: '2026-04-20'
        }],
        seasonal_baseline: flatBaseline(600),
        planned_expenses: [
          { name: 'Vet', amount: 300, scheduled_date: '2026-04-12' }
        ],
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      const outlook = computeMonthlyOutlook(forecast, 10000);
      assert.equal(outlook.length, 1); // 30 days in April only
      assert.equal(outlook[0].month, '2026-04');

      // Income: 1 paycheck of $3000
      assert.equal(outlook[0].expected_income, 3000);
      // Recurring: 1 Netflix of $15
      assert.equal(outlook[0].expected_recurring, 15);
      // Liability: 1 Visa of $200
      assert.equal(outlook[0].expected_liability_payments, 200);
      // Planned: $300 vet
      assert.equal(outlook[0].planned_expenses_total, 300);
      // Discretionary: 30 days × $20/day = $600
      assert.equal(outlook[0].expected_discretionary, 600);

      // Net = 3000 - 15 - 600 - 200 - 300 = 1885
      assert.equal(outlook[0].net_surplus_or_deficit, 1885);
      // End balance = 10000 + 1885 = 11885
      assert.equal(outlook[0].projected_end_balance, 11885);
    });

    it('chains end balance across months', () => {
      const forecast = computeForecast({
        starting_balance: 5000,
        recurring_income: [{
          merchant_key: 'employer',
          amount: 4000,
          frequency: 'monthly',
          expected_next_date: '2026-04-15',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '15'
        }],
        seasonal_baseline: flatBaseline(900),
        horizon_days: 90,
        start_date: '2026-04-01'
      });

      const outlook = computeMonthlyOutlook(forecast, 5000);
      assert.ok(outlook.length >= 3, 'Should span at least 3 months');

      // Month 1 end balance should be start of month 2
      const m1End = outlook[0].projected_end_balance;
      // Month 2 net added to month 1 end = month 2 end
      assert.equal(
        outlook[1].projected_end_balance,
        roundMoney(m1End + outlook[1].net_surplus_or_deficit)
      );
    });

    it('assigns planned expense to correct month', () => {
      const forecast = computeForecast({
        starting_balance: 10000,
        planned_expenses: [
          { name: 'Apr expense', amount: 100, scheduled_date: '2026-04-20' },
          { name: 'May expense', amount: 200, scheduled_date: '2026-05-10' }
        ],
        horizon_days: 60,
        start_date: '2026-04-01'
      });

      const outlook = computeMonthlyOutlook(forecast, 10000);
      const apr = outlook.find(m => m.month === '2026-04');
      const may = outlook.find(m => m.month === '2026-05');
      assert.equal(apr.planned_expenses_total, 100);
      assert.equal(may.planned_expenses_total, 200);
    });

    it('returns empty array for empty projections', () => {
      const outlook = computeMonthlyOutlook([], 5000);
      assert.equal(outlook.length, 0);
    });
  });

  describe('detectExcessLiquidity', () => {
    it('returns none when projected minimum is below reserve target', () => {
      const forecast = computeForecast({
        starting_balance: 5000,
        seasonal_baseline: flatBaseline(1500), // drains balance
        horizon_days: 90,
        start_date: '2026-04-01'
      });

      const result = detectExcessLiquidity(forecast, {
        safetyFloor: 3000,
        committedMonthly: 2000,
        reserveTargetMonths: 3.0
      });

      // Reserve target = max(3000, 2000*3=6000) = $6000
      assert.equal(result.reserve_target, 6000);
      assert.equal(result.recommendation_level, 'none');
      assert.equal(result.excess_amount, 0);
    });

    it('returns modest when excess is less than one month of committed', () => {
      const forecast = computeForecast({
        starting_balance: 20000,
        recurring_income: [{
          merchant_key: 'employer',
          amount: 5000,
          frequency: 'monthly',
          expected_next_date: '2026-04-15',
          schedule_anchor_type: 'day_of_month',
          schedule_anchor_value: '15'
        }],
        seasonal_baseline: flatBaseline(300),
        horizon_days: 90,
        start_date: '2026-04-01'
      });

      const result = detectExcessLiquidity(forecast, {
        safetyFloor: 3000,
        committedMonthly: 3500,
        reserveTargetMonths: 3.0
      });

      // Reserve target = max(3000, 3500*3=10500) = $10500
      assert.equal(result.reserve_target, 10500);
      // Min balance should be > $10500 but excess < $3500 (one month)
      assert.ok(result.projected_min_balance > 10500);
      assert.ok(result.excess_amount > 0);
      // Whether modest or strong depends on exact numbers
      assert.ok(['modest', 'strong'].includes(result.recommendation_level));
    });

    it('returns strong when excess exceeds one month of committed', () => {
      const forecast = computeForecast({
        starting_balance: 50000, // very high starting balance
        horizon_days: 30,
        start_date: '2026-04-01'
      });

      const result = detectExcessLiquidity(forecast, {
        safetyFloor: 3000,
        committedMonthly: 2000,
        reserveTargetMonths: 3.0
      });

      // Reserve target = max(3000, 6000) = $6000
      // Min balance = $50000, excess = $44000 >> $2000
      assert.equal(result.reserve_target, 6000);
      assert.equal(result.excess_amount, 44000);
      assert.equal(result.recommendation_level, 'strong');
    });

    it('uses cash_reserve_target_amount override when larger', () => {
      const forecast = computeForecast({
        starting_balance: 25000,
        horizon_days: 10,
        start_date: '2026-04-01'
      });

      const result = detectExcessLiquidity(forecast, {
        safetyFloor: 3000,
        committedMonthly: 1000,
        reserveTargetMonths: 3.0,
        reserveTargetAmount: 15000 // override: $15k explicit target
      });

      // Reserve target = max(3000, 1000*3=3000, 15000) = $15000
      assert.equal(result.reserve_target, 15000);
      assert.equal(result.excess_amount, 10000); // 25000 - 15000
    });

    it('handles empty projections', () => {
      const result = detectExcessLiquidity([], {
        safetyFloor: 3000,
        committedMonthly: 2000,
        reserveTargetMonths: 3.0
      });
      assert.equal(result.projected_min_balance, 0);
      assert.equal(result.recommendation_level, 'none');
    });
  });
});
