'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { suggestCategoryNameFromPlaid } = require('../lib/plaid-category-mapper');

describe('Plaid category mapper', () => {
  it('maps grocery detailed categories', () => {
    const result = suggestCategoryNameFromPlaid({
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_GROCERIES'
    });
    assert.equal(result, 'Groceries');
  });

  it('maps income primary categories', () => {
    const result = suggestCategoryNameFromPlaid({
      primary: 'INCOME',
      detailed: 'INCOME_WAGES'
    });
    assert.equal(result, 'Income');
  });

  it('returns null for unknown categories', () => {
    const result = suggestCategoryNameFromPlaid({
      primary: 'GENERAL_SERVICES',
      detailed: 'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING'
    });
    assert.equal(result, null);
  });
});
