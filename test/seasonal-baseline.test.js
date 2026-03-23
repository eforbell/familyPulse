'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSeasonalBaselineFromData,
  bucketByCalendarMonth,
  buildBaseline,
  median
} = require('../lib/seasonal-baseline');

// Helper: generate a transaction fixture
function tx(amount, date, merchant = 'TestMerchant') {
  return {
    amount,
    date,
    merchant_name: merchant,
    name: merchant
  };
}

// Generate monthly transactions across a date range
function generateMonthlyTxns(startYear, startMonth, count, amountFn, merchant = 'SomeStore') {
  const txns = [];
  for (let i = 0; i < count; i++) {
    const m = ((startMonth - 1 + i) % 12) + 1;
    const y = startYear + Math.floor((startMonth - 1 + i) / 12);
    const date = `${y}-${String(m).padStart(2, '0')}-15`;
    txns.push(tx(amountFn(i, m), date, merchant));
  }
  return txns;
}

describe('seasonal-baseline', () => {
  describe('median', () => {
    it('returns median of odd-length array', () => {
      assert.equal(median([3, 1, 2]), 2);
    });

    it('returns median of even-length array', () => {
      assert.equal(median([4, 1, 3, 2]), 2.5);
    });

    it('returns 0 for empty array', () => {
      assert.equal(median([]), 0);
    });

    it('returns single value for single-element array', () => {
      assert.equal(median([42]), 42);
    });
  });

  describe('computeSeasonalBaselineFromData', () => {
    it('produces 12 months of baseline data', () => {
      const txns = [tx(100, '2025-01-15'), tx(200, '2025-02-15')];
      const baseline = computeSeasonalBaselineFromData(txns);
      assert.equal(baseline.length, 12);
      assert.equal(baseline[0].month, 1);
      assert.equal(baseline[11].month, 12);
    });

    it('computes median discretionary for a single month with multiple years', () => {
      // January across 3 years: $100, $200, $300 → median $200
      const txns = [
        tx(100, '2024-01-10', 'Store A'),
        tx(200, '2025-01-10', 'Store B'),
        tx(300, '2026-01-10', 'Store C')
      ];
      const baseline = computeSeasonalBaselineFromData(txns);
      const jan = baseline.find(b => b.month === 1);
      assert.equal(jan.median_discretionary, 200);
      assert.equal(jan.sample_months, 3);
      assert.equal(jan.confidence, 'good');
    });

    it('subtracts recurring merchant spend from discretionary', () => {
      const recurringKeys = new Set(['netflix com']);
      const txns = [
        tx(15.49, '2025-01-05', 'NETFLIX.COM/123456789'),  // recurring (normalizes to 'netflix com')
        tx(85.00, '2025-01-20', 'Grocery Store'),            // discretionary
        tx(15.49, '2026-01-05', 'NETFLIX.COM/987654321'),  // recurring
        tx(120.00, '2026-01-20', 'Grocery Store')            // discretionary
      ];
      const baseline = computeSeasonalBaselineFromData(txns, recurringKeys);
      const jan = baseline.find(b => b.month === 1);

      // Jan 2025: recurring=15.49, discretionary=85.00
      // Jan 2026: recurring=15.49, discretionary=120.00
      // Median discretionary = (85 + 120) / 2 = 102.50
      assert.equal(jan.median_discretionary, 102.50);
      assert.equal(jan.median_recurring, 15.49);
    });

    it('falls back to overall average for months with no data', () => {
      // Only have data for January and February
      const txns = [
        tx(100, '2025-01-15', 'Store'),
        tx(200, '2025-02-15', 'Store')
      ];
      const baseline = computeSeasonalBaselineFromData(txns);

      // Months without data should use the overall median of $100 and $200 = $150
      const march = baseline.find(b => b.month === 3);
      assert.equal(march.confidence, 'fallback');
      assert.equal(march.median_discretionary, 150);

      // December should also be fallback
      const dec = baseline.find(b => b.month === 12);
      assert.equal(dec.confidence, 'fallback');
      assert.equal(dec.median_discretionary, 150);
    });

    it('handles sparse data window (4-5 months) gracefully', () => {
      // Simulate 5 months of data: Nov 2025 through Mar 2026
      const txns = [
        tx(800, '2025-11-15', 'Various'), // November
        tx(1200, '2025-12-15', 'Holiday Shopping'), // December (holiday spike)
        tx(600, '2026-01-15', 'Various'), // January
        tx(700, '2026-02-15', 'Various'), // February
        tx(650, '2026-03-15', 'Various')  // March
      ];
      const baseline = computeSeasonalBaselineFromData(txns);

      // Months with data should have sample_months=1 and confidence=limited
      const nov = baseline.find(b => b.month === 11);
      assert.equal(nov.sample_months, 1);
      assert.equal(nov.confidence, 'limited');
      assert.equal(nov.median_discretionary, 800);

      // Months without data should have fallback
      const april = baseline.find(b => b.month === 4);
      assert.equal(april.confidence, 'fallback');
      // Overall median of [800, 1200, 600, 700, 650] = 700
      assert.equal(april.median_discretionary, 700);
    });

    it('handles 14 months of rich data correctly', () => {
      // 14 months: Jan 2025 through Feb 2026
      const txns = [
        // Year 1
        tx(500, '2025-01-15', 'Store'), tx(600, '2025-02-15', 'Store'),
        tx(550, '2025-03-15', 'Store'), tx(700, '2025-04-15', 'Store'),
        tx(650, '2025-05-15', 'Store'), tx(800, '2025-06-15', 'Store'),
        tx(750, '2025-07-15', 'Store'), tx(850, '2025-08-15', 'Store'),
        tx(900, '2025-09-15', 'Store'), tx(950, '2025-10-15', 'Store'),
        tx(1000, '2025-11-15', 'Store'), tx(1200, '2025-12-15', 'Store'),
        // Year 2 overlap
        tx(520, '2026-01-15', 'Store'), tx(580, '2026-02-15', 'Store')
      ];
      const baseline = computeSeasonalBaselineFromData(txns);

      // January: [500, 520] → median = 510
      const jan = baseline.find(b => b.month === 1);
      assert.equal(jan.sample_months, 2);
      assert.equal(jan.median_discretionary, 510);
      assert.equal(jan.confidence, 'good');

      // February: [600, 580] → median = 590
      const feb = baseline.find(b => b.month === 2);
      assert.equal(feb.median_discretionary, 590);

      // March through December: single sample each
      const june = baseline.find(b => b.month === 6);
      assert.equal(june.sample_months, 1);
      assert.equal(june.median_discretionary, 800);
      assert.equal(june.confidence, 'limited');
    });

    it('aggregates multiple transactions within the same month correctly', () => {
      const txns = [
        tx(50, '2025-03-01', 'Grocery'),
        tx(30, '2025-03-10', 'Gas'),
        tx(20, '2025-03-20', 'Coffee'),
        tx(80, '2026-03-05', 'Grocery'),
        tx(40, '2026-03-15', 'Gas')
      ];
      const baseline = computeSeasonalBaselineFromData(txns);
      const march = baseline.find(b => b.month === 3);

      // Mar 2025: 50+30+20 = 100
      // Mar 2026: 80+40 = 120
      // Median discretionary: (100+120)/2 = 110
      assert.equal(march.median_discretionary, 110);
      assert.equal(march.sample_months, 2);
    });

    it('returns all zeros for empty input', () => {
      const baseline = computeSeasonalBaselineFromData([]);
      assert.equal(baseline.length, 12);
      for (const entry of baseline) {
        assert.equal(entry.median_discretionary, 0);
        assert.equal(entry.median_total, 0);
        assert.equal(entry.sample_months, 0);
        // When no data at all, fallback median is 0
        assert.equal(entry.confidence, 'fallback');
      }
    });

    it('handles negative amounts by using absolute values', () => {
      // Even though we expect positive (debit) amounts, test robustness
      const txns = [tx(-100, '2025-06-15', 'Store')];
      const baseline = computeSeasonalBaselineFromData(txns);
      const june = baseline.find(b => b.month === 6);
      assert.equal(june.median_discretionary, 100); // absolute value
    });

    it('correctly separates recurring from discretionary across months', () => {
      const recurringKeys = new Set(['spotify usa', 'netflix com']);
      const txns = [
        // March 2025
        tx(9.99, '2025-03-01', 'Spotify USA LLC'),         // recurring (normalizes to 'spotify usa')
        tx(15.49, '2025-03-05', 'NETFLIX.COM/123456789'),  // recurring (normalizes to 'netflix com')
        tx(200, '2025-03-15', 'Grocery Store'),             // discretionary
        // March 2026
        tx(10.99, '2026-03-01', 'Spotify USA LLC'),         // recurring
        tx(22.99, '2026-03-05', 'NETFLIX.COM/987654321'),  // recurring
        tx(250, '2026-03-15', 'Grocery Store')              // discretionary
      ];
      const baseline = computeSeasonalBaselineFromData(txns, recurringKeys);
      const march = baseline.find(b => b.month === 3);

      // Mar 2025: recurring=9.99+15.49=25.48, discretionary=200
      // Mar 2026: recurring=10.99+22.99=33.98, discretionary=250
      // Median recurring: (25.48+33.98)/2 = 29.73
      // Median discretionary: (200+250)/2 = 225
      assert.equal(march.median_recurring, 29.73);
      assert.equal(march.median_discretionary, 225);
    });

    it('uses median not mean to resist outlier skew', () => {
      // 3 Januaries: $500, $600, $5000 (outlier)
      // Mean = 2033.33, Median = 600
      const txns = [
        tx(500, '2024-01-15', 'Store'),
        tx(600, '2025-01-15', 'Store'),
        tx(5000, '2026-01-15', 'Store')
      ];
      const baseline = computeSeasonalBaselineFromData(txns);
      const jan = baseline.find(b => b.month === 1);
      assert.equal(jan.median_discretionary, 600); // median, not 2033.33
    });
  });

  describe('bucketByCalendarMonth', () => {
    it('groups transactions into correct calendar months', () => {
      const txns = [
        tx(100, '2025-01-15', 'A'),
        tx(200, '2025-01-25', 'B'),
        tx(300, '2025-07-10', 'C')
      ];
      const buckets = bucketByCalendarMonth(txns, new Set());

      const janBucket = buckets.get(1);
      assert.equal(janBucket.size, 1); // one year-month (2025-01)
      assert.equal(janBucket.get('2025-01').total, 300); // 100+200

      const julBucket = buckets.get(7);
      assert.equal(julBucket.size, 1);
      assert.equal(julBucket.get('2025-07').total, 300);
    });

    it('separates same calendar month across different years', () => {
      const txns = [
        tx(100, '2024-06-15', 'A'),
        tx(200, '2025-06-15', 'B')
      ];
      const buckets = bucketByCalendarMonth(txns, new Set());
      const juneBucket = buckets.get(6);
      assert.equal(juneBucket.size, 2); // 2024-06 and 2025-06
    });
  });
});
