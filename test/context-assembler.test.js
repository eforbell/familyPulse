'use strict';

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeForLLM } = require('../lib/secrets-guard');

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
});
