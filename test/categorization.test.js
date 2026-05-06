'use strict';

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { categorizeTransaction } = require('../lib/categorization');

const rules = [
  { id: 1, merchant_pattern: 'Starbucks', category_id: 10, match_type: 'exact' },
  { id: 2, merchant_pattern: 'amazon', category_id: 20, match_type: 'contains' },
  { id: 3, merchant_pattern: 'whole foods', category_id: 30, match_type: 'contains' },
  { id: 4, merchant_pattern: 'target', category_id: 40, match_type: 'contains' },
];

describe('categorizeTransaction', () => {
  it('matches exact rule (case-insensitive)', () => {
    const tx = { merchant_name: 'starbucks', name: 'STARBUCKS #1234' };
    assert.equal(categorizeTransaction(tx, rules), 10);
  });

  it('matches contains rule', () => {
    const tx = { merchant_name: 'AMAZON.COM', name: 'Amazon Purchase' };
    assert.equal(categorizeTransaction(tx, rules), 20);
  });

  it('prefers exact match over contains', () => {
    // If we add a contains rule for "Starbucks" too, exact should win
    const extRules = [
      ...rules,
      { id: 5, merchant_pattern: 'Starbucks', category_id: 99, match_type: 'contains' }
    ];
    const tx = { merchant_name: 'Starbucks', name: 'STARBUCKS #1234' };
    assert.equal(categorizeTransaction(tx, extRules), 10);
  });

  it('falls back to name when merchant_name is empty', () => {
    const tx = { merchant_name: '', name: 'Amazon Prime' };
    assert.equal(categorizeTransaction(tx, rules), 20);
  });

  it('falls back to name when merchant_name is null', () => {
    const tx = { merchant_name: null, name: 'WHOLE FOODS MARKET' };
    assert.equal(categorizeTransaction(tx, rules), 30);
  });

  it('matches exact rules against statement name even when merchant_name differs', () => {
    const tx = { merchant_name: 'Merchant Alias', name: 'Starbucks' };
    assert.equal(categorizeTransaction(tx, rules), 10);
  });

  it('matches contains rules against statement name even when merchant_name differs', () => {
    const tx = { merchant_name: 'Merchant Alias', name: 'Whole Foods Market' };
    assert.equal(categorizeTransaction(tx, rules), 30);
  });

  it('returns null when no match', () => {
    const tx = { merchant_name: 'McDonalds', name: 'MCDONALDS #5678' };
    assert.equal(categorizeTransaction(tx, rules), null);
  });

  it('is case-insensitive for contains', () => {
    const tx = { merchant_name: 'TARGET STORE #123', name: '' };
    assert.equal(categorizeTransaction(tx, rules), 40);
  });

  it('handles empty transaction gracefully', () => {
    const tx = { merchant_name: '', name: '' };
    assert.equal(categorizeTransaction(tx, rules), null);
  });

  it('handles null fields gracefully', () => {
    const tx = { merchant_name: null, name: null };
    assert.equal(categorizeTransaction(tx, rules), null);
  });
});
