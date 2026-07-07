'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fingerprintForTransaction,
  decideLearnedCategory
} = require('../lib/learned-categorization');

describe('learned categorization decisions', () => {
  it('builds the same merchant fingerprint used by recurring detection', () => {
    assert.equal(
      fingerprintForTransaction({ merchant_name: 'MOBIL #123456789', name: 'MOBIL 07/01/2026' }),
      'mobil'
    );
  });

  it('trusts an explicit learned rule at count one', () => {
    const signals = {
      learnedRules: new Map([['coffee shop', 10]]),
      histories: new Map(),
      rejections: new Set(),
      plaidCategoryIdsByName: new Map()
    };

    assert.deepEqual(
      decideLearnedCategory({ merchant_fingerprint: 'coffee shop' }, signals),
      { action: 'apply', categoryId: 10, source: 'learned' }
    );
  });

  it('auto-applies only unanimous history with at least three eligible priors', () => {
    const signals = {
      learnedRules: new Map(),
      histories: new Map([
        ['three timer', { total: 3, counts: [{ category_id: 20, count: 3 }] }],
        ['two timer', { total: 2, counts: [{ category_id: 20, count: 2 }] }]
      ]),
      rejections: new Set(),
      plaidCategoryIdsByName: new Map()
    };

    assert.deepEqual(
      decideLearnedCategory({ merchant_fingerprint: 'three timer' }, signals),
      { action: 'apply', categoryId: 20, source: 'learned' }
    );
    assert.deepEqual(
      decideLearnedCategory({ merchant_fingerprint: 'two timer' }, signals),
      { action: 'none' }
    );
  });

  it('turns majority history into a suggestion unless rejected', () => {
    const baseSignals = {
      learnedRules: new Map(),
      histories: new Map([
        ['mixed merchant', { total: 5, counts: [{ category_id: 30, count: 3 }, { category_id: 40, count: 2 }] }]
      ]),
      rejections: new Set(),
      plaidCategoryIdsByName: new Map()
    };

    assert.deepEqual(
      decideLearnedCategory({ merchant_fingerprint: 'mixed merchant' }, baseSignals),
      { action: 'suggest', categoryId: 30, source: 'history' }
    );

    assert.deepEqual(
      decideLearnedCategory(
        { merchant_fingerprint: 'mixed merchant' },
        { ...baseSignals, rejections: new Set(['mixed merchant:30']) }
      ),
      { action: 'none' }
    );
  });

  it('demotes Plaid taxonomy to suggestion-only', () => {
    const signals = {
      learnedRules: new Map(),
      histories: new Map(),
      rejections: new Set(),
      plaidCategoryIdsByName: new Map([['Groceries', 50]])
    };

    assert.deepEqual(
      decideLearnedCategory({ merchant_fingerprint: 'new grocer', plaid_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }, signals),
      { action: 'suggest', categoryId: 50, source: 'plaid' }
    );
  });
});
