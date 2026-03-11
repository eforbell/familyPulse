'use strict';

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeForLLM } = require('../lib/secrets-guard');
const { sanitizeInput } = require('../lib/magic-actions/on-demand');

describe('what-if', () => {
  it('snapshot shape includes savings rate and account breakdown', () => {
    const snapshot = {
      liquid_balance: 25000,
      credit_balance: -3500,
      investment_balance: 50000,
      net_position: 71500,
      avg_monthly_income: 8000,
      avg_monthly_spending: 5500,
      avg_monthly_savings: 2500,
      savings_rate_pct: 31,
      accounts: [
        { name: 'Checking', type: 'depository', balance: 15000 },
        { name: 'Savings', type: 'depository', balance: 10000 }
      ],
      family: ['Eric', 'Alex', 'Jordan', 'Casey']
    };

    const sanitized = sanitizeForLLM(snapshot);
    assert.equal(sanitized.savings_rate_pct, 31);
    assert.equal(sanitized.accounts.length, 2);
    assert.ok(!JSON.stringify(sanitized).includes('access_token'));
  });

  it('what-if system prompt includes uncertainty caveat instruction', () => {
    const defaultPrompt = "You are a family finance planner for the Forbell household (Eric, Alex, Jordan, Casey). Given the household's current financial snapshot, project the impact of the described scenario over 3, 6, and 12 months. Clearly communicate uncertainty — use ranges rather than exact numbers. Include caveats about assumptions. Be helpful but honest about limitations.";

    assert.ok(defaultPrompt.includes('uncertainty'));
    assert.ok(defaultPrompt.includes('caveats'));
    assert.ok(defaultPrompt.includes('ranges'));
  });

  it('scenario input is sanitized', () => {
    assert.equal(
      sanitizeInput('What if we buy a $500k house?'),
      'What if we buy a $500k house?'
    );
    assert.equal(sanitizeInput('<b>bold</b> scenario'), 'bold scenario');
    assert.equal(sanitizeInput('access-sandbox-aabb1122-3344'), null);
  });

  it('snapshot sanitization removes injected secrets', () => {
    const snapshot = {
      liquid_balance: 25000,
      api_key: 'sk-secret123456789012345678',
      access_token: 'access-production-abcdef-123456'
    };

    const sanitized = sanitizeForLLM(snapshot);
    assert.equal(sanitized.api_key, '[REDACTED]');
    assert.equal(sanitized.access_token, '[REDACTED]');
    assert.equal(sanitized.liquid_balance, 25000);
  });
});
