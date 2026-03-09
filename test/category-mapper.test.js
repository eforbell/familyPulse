'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { suggestMappings, diceCoefficient } = require('../lib/category-mapper');

// Simulated Family Pulse categories (mirrors seed.sql)
const FP_CATEGORIES = [
  { id: 1, name: 'Groceries' },
  { id: 2, name: 'Dining Out' },
  { id: 3, name: 'Gas & Auto' },
  { id: 4, name: 'Utilities' },
  { id: 5, name: 'Healthcare' },
  { id: 6, name: 'Entertainment' },
  { id: 7, name: 'Shopping' },
  { id: 8, name: 'Kids Activities' },
  { id: 9, name: 'Subscriptions' },
  { id: 10, name: 'Home & Garden' },
  { id: 11, name: 'Insurance' },
  { id: 12, name: 'Travel' },
  { id: 13, name: 'Income' },
  { id: 14, name: 'Transfer' },
  { id: 15, name: 'CC Payment' },
  { id: 16, name: '529 Contribution' },
  { id: 17, name: 'Crypto/BTC' },
  { id: 18, name: 'Uncategorized' }
];

describe('diceCoefficient', () => {
  it('returns 1 for identical strings', () => {
    assert.equal(diceCoefficient('hello', 'hello'), 1);
  });

  it('returns 0 for completely different strings', () => {
    assert.equal(diceCoefficient('ab', 'yz'), 0);
  });

  it('returns value between 0 and 1 for partial match', () => {
    const score = diceCoefficient('groceries', 'grocery');
    assert.ok(score > 0.5);
    assert.ok(score < 1);
  });
});

describe('suggestMappings', () => {
  it('maps known Monarch categories via lookup table', () => {
    const monarchCats = ['Groceries', 'Fast Food', 'Bitcoin Savings', 'Credit Card Payment'];
    const result = suggestMappings(monarchCats, FP_CATEGORIES);

    assert.equal(result.mapped['Groceries'].fpName, 'Groceries');
    assert.equal(result.mapped['Fast Food'].fpName, 'Dining Out');
    assert.equal(result.mapped['Bitcoin Savings'].fpName, 'Crypto/BTC');
    assert.equal(result.mapped['Credit Card Payment'].fpName, 'CC Payment');
    assert.equal(result.unmapped.length, 0);
  });

  it('maps income categories to Income', () => {
    const monarchCats = ['Interest', 'Paychecks (Net)', 'Bonus (Net)', 'Other Income'];
    const result = suggestMappings(monarchCats, FP_CATEGORIES);

    for (const mc of monarchCats) {
      assert.equal(result.mapped[mc].fpName, 'Income');
    }
  });

  it('marks truly unknown categories as unmapped', () => {
    const monarchCats = ['Xylophone Lessons'];
    const result = suggestMappings(monarchCats, FP_CATEGORIES);
    assert.equal(result.unmapped.length, 1);
    assert.equal(result.unmapped[0], 'Xylophone Lessons');
  });

  it('is case-insensitive for known mappings', () => {
    const result = suggestMappings(['GROCERIES', 'fast food'], FP_CATEGORIES);
    assert.equal(result.mapped['GROCERIES'].fpName, 'Groceries');
    assert.equal(result.mapped['fast food'].fpName, 'Dining Out');
  });

  it('maps all real Monarch categories from the export', () => {
    const realMonarchCats = [
      'Interest', 'Shopping', 'Restaurants & Bars', 'Kids 529 College Savings',
      'Home Improvement', 'Gas', 'Transfer', 'Bitcoin Savings', 'Charity',
      'Parking & Tolls', 'Security', 'Adobe Lightroom', 'Groceries',
      'Entertainment & Recreation', 'Credit Card Payment', 'Fast Food',
      'Paychecks (Net)', 'Other Income', 'Subscriptions', 'Travel & Vacation',
      'Streaming Service', 'Child Activities', 'Auto Payment', 'Medical',
      'Clothing', 'Treats', 'Phone', 'Gas & Electric', 'Mortgage',
      'Web Service', 'Coffee Shops', 'Cleaners', 'Furniture & Housewares',
      'Auto Maintenance', 'Postage & Shipping', 'Gifts', 'Cash & ATM',
      'Financial Fees', 'Uncategorized', 'Bonus (Net)', 'Car Insurance',
      'Personal', 'Golf', 'Education', 'Office Supplies & Expenses',
      'Miscellaneous', 'Salon/Haircare', 'Software Service'
    ];

    const result = suggestMappings(realMonarchCats, FP_CATEGORIES);
    // Every real Monarch category should map — none unmapped
    assert.equal(result.unmapped.length, 0,
      `Unmapped categories: ${result.unmapped.join(', ')}`);
  });
});
