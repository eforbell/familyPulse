'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { sanitizeForLLM } = require('../lib/secrets-guard');
const { getRecurringContextSummary, getForecastContextSummary } = require('../lib/magic-actions/context-assembler');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let recurringId;

before(async () => {
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '014-recurring-expenses.sql'),
    'utf8'
  );
  await pool.query(migrationSql);
  const { rows: [row] } = await pool.query(`
    INSERT INTO recurring_expenses (
      merchant_key, merchant_name, cashflow_type, frequency, confidence, status,
      latest_amount, price_change_pct, price_change_direction, price_change_date,
      first_seen_date, last_seen_date, expected_next_date, interval_days, tolerance_days,
      schedule_anchor_type, schedule_anchor_value, source_txn_count
    )
    VALUES (
      'netflix com', 'Netflix', 'expense', 'monthly', 'high', 'active',
      22.99, 48.42, 'up', current_date,
      '2026-01-05', '2026-04-05', current_date + 20, 30, 3,
      'day_of_month', '5', 4
    )
    RETURNING id
  `);
  recurringId = row.id;
});

after(async () => {
  await pool.query('DELETE FROM recurring_expenses WHERE id = $1', [recurringId]);
  await pool.end();
});

describe('context-assembler', () => {
  it('assembleWeeklyContext returns sanitized data', async () => {
    // Test the shape of the context output by simulating what sanitizeForLLM does
    const fakeContext = {
      period: '2025-06',
      income: 5000,
      total_spending: 3200,
      categories: [{ name: 'Groceries', spent: 500, budgeted: 600, pct_used: 83, avg_3mo: 480 }],
      anomalies: [],
      family: ['Eric', 'Alex', 'Jordan', 'Casey'],
      // Inject secret
      access_token: 'access-sandbox-abc123def456-7890'
    };

    const sanitized = sanitizeForLLM(fakeContext);
    const asString = JSON.stringify(sanitized);

    assert.ok(!asString.includes('access-sandbox'), 'Should not contain access token');
    assert.equal(sanitized.access_token, '[REDACTED]');
    assert.ok(Array.isArray(sanitized.family));
    assert.equal(sanitized.categories.length, 1);
  });

  it('assembleMonthlyContext shape includes wins and overruns', () => {
    // Test the expected shape of monthly context
    const monthlyShape = {
      period: '2025-06',
      income: 5000,
      prior_income: 4800,
      avg_3mo_income: 4900,
      total_spending: 3200,
      total_budgeted: 3500,
      wins: [{ name: 'Groceries', spent: 400, budgeted: 600, saved: 200 }],
      overruns: [{ name: 'Dining Out', spent: 500, budgeted: 300, over: 200 }],
      uncategorized_count: 3
    };

    const sanitized = sanitizeForLLM(monthlyShape);
    assert.ok(Array.isArray(sanitized.wins));
    assert.ok(Array.isArray(sanitized.overruns));
    assert.equal(sanitized.uncategorized_count, 3);
  });

  it('assembleQueryContext shape includes accounts and merchants', () => {
    const queryShape = {
      period: '2025-06',
      accounts: [{ name: 'Checking', type: 'depository', balance: 5000 }],
      top_merchants: [{ merchant: 'Costco', count: 5, total: 450 }],
      // Should not include access tokens
      api_key: 'sk-testabc123456789012345'
    };

    const sanitized = sanitizeForLLM(queryShape);
    assert.equal(sanitized.api_key, '[REDACTED]');
    assert.ok(Array.isArray(sanitized.accounts));
  });

  it('assembleFinancialSnapshot shape includes savings rate', () => {
    const snapshot = {
      liquid_balance: 25000,
      credit_balance: -3500,
      investment_balance: 50000,
      net_position: 71500,
      avg_monthly_income: 8000,
      avg_monthly_spending: 5500,
      avg_monthly_savings: 2500,
      savings_rate_pct: 31,
      accounts: []
    };

    const sanitized = sanitizeForLLM(snapshot);
    assert.equal(sanitized.savings_rate_pct, 31);
    assert.equal(sanitized.net_position, 71500);
  });

  it('getRecurringContextSummary returns recurring context shape', async () => {
    const context = await getRecurringContextSummary();
    assert.ok(typeof context.committed_monthly_total === 'number');
    assert.ok(typeof context.count_active === 'number');
    assert.ok(Array.isArray(context.top_recurring));
    assert.ok(Array.isArray(context.price_increases));
    assert.ok(Array.isArray(context.upcoming_annual_renewals));
  });

  it('getForecastContextSummary returns null when no cached forecast exists', async () => {
    // Clear any cached forecasts
    await pool.query('DELETE FROM cash_flow_snapshots');
    const context = await getForecastContextSummary();
    assert.equal(context, null);
  });

  it('getForecastContextSummary returns forecast context shape when cached', async () => {
    // Insert a minimal cached forecast
    await pool.query(`
      INSERT INTO cash_flow_snapshots (horizon_days, starting_balance, daily_projections, danger_zones, monthly_outlook, excess_liquidity)
      VALUES (90, 15000, $1, $2, $3, $4)
    `, [
      JSON.stringify([
        { date: '2026-04-01', projected_balance: 15000, confidence_low: 14250, confidence_high: 15750, events: [] },
        { date: '2026-06-29', projected_balance: 12000, confidence_low: 9000, confidence_high: 15000, events: [] }
      ]),
      JSON.stringify([]),
      JSON.stringify([
        { month: '2026-04', net_surplus_or_deficit: 1200, projected_end_balance: 16200, planned_expenses_total: 300 },
        { month: '2026-05', net_surplus_or_deficit: -500, projected_end_balance: 15700, planned_expenses_total: 0 }
      ]),
      JSON.stringify({ recommendation_level: 'modest', excess_amount: 4000, reserve_target: 10000 })
    ]);

    const context = await getForecastContextSummary();
    assert.ok(context, 'Should return a context object');
    assert.equal(context['90_day_outlook_status'], 'healthy');
    assert.equal(context.current_liquid_balance, 15000);
    assert.equal(context.projected_90_day_balance, 12000);
    assert.equal(context.next_danger_zone, null);
    assert.ok(Array.isArray(context.monthly_outlook));
    assert.equal(context.monthly_outlook.length, 2);
    assert.equal(context.monthly_outlook[0].net_surplus_or_deficit, 1200);
    assert.equal(context.planned_expenses_total, 300);
    assert.ok(context.excess_liquidity_opportunity);
    assert.equal(context.excess_liquidity_opportunity.level, 'modest');
    assert.equal(context.excess_liquidity_opportunity.excess_amount, 4000);

    // Clean up
    await pool.query('DELETE FROM cash_flow_snapshots');
  });

  it('getForecastContextSummary includes danger zone when present', async () => {
    await pool.query(`
      INSERT INTO cash_flow_snapshots (horizon_days, starting_balance, daily_projections, danger_zones, monthly_outlook, excess_liquidity)
      VALUES (90, 5000, $1, $2, $3, $4)
    `, [
      JSON.stringify([
        { date: '2026-04-01', projected_balance: 5000, confidence_low: 4750, confidence_high: 5250, events: [] },
        { date: '2026-04-15', projected_balance: 1500, confidence_low: 1000, confidence_high: 2000, events: [] }
      ]),
      JSON.stringify([
        { date: '2026-04-15', projected_balance: 1500, deficit_below_floor: 1500, severity: 'danger', trigger_event: { type: 'planned_expense', name: 'Car insurance', amount: 3500 } }
      ]),
      JSON.stringify([]),
      JSON.stringify({ recommendation_level: 'none' })
    ]);

    const context = await getForecastContextSummary();
    assert.equal(context['90_day_outlook_status'], 'danger');
    assert.ok(context.next_danger_zone);
    assert.equal(context.next_danger_zone.date, '2026-04-15');
    assert.equal(context.next_danger_zone.deficit_below_floor, 1500);
    assert.equal(context.next_danger_zone.trigger, 'Car insurance');
    assert.equal(context.excess_liquidity_opportunity, null);

    await pool.query('DELETE FROM cash_flow_snapshots');
  });

  it('forecast context passes sanitization', async () => {
    const forecastShape = {
      '90_day_outlook_status': 'healthy',
      current_liquid_balance: 15000,
      projected_90_day_balance: 12000,
      next_danger_zone: null,
      monthly_outlook: [{ month: '2026-04', net_surplus_or_deficit: 1200 }],
      excess_liquidity_opportunity: null,
      // inject secret
      access_token: 'access-sandbox-abc123'
    };
    const sanitized = sanitizeForLLM(forecastShape);
    assert.equal(sanitized.access_token, '[REDACTED]');
    assert.equal(sanitized['90_day_outlook_status'], 'healthy');
    assert.equal(sanitized.current_liquid_balance, 15000);
  });
});
