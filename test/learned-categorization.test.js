'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fingerprintForTransaction,
  decideLearnedCategory,
  captureManualLearning,
  rejectSuggestion
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

  it('isolates optional learning failures behind a savepoint', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql === 'SELECT COALESCE(exclude_from_learning, false) AS exclude_from_learning FROM categories WHERE id = $1') {
          return { rows: [{ exclude_from_learning: false }] };
        }
        if (String(sql).includes('INSERT INTO learned_category_rules')) {
          throw new Error('simulated learning write failure');
        }
        return { rows: [] };
      }
    };

    const result = await captureManualLearning(
      client,
      { id: 123, merchant_name: 'Coffee Shop', name: 'Coffee Shop' },
      10
    );

    assert.deepEqual(result, { learned: false, reason: 'error' });
    assert.equal(queries[0].sql, 'SAVEPOINT manual_learning');
    assert.ok(queries.some(query => query.sql === 'ROLLBACK TO SAVEPOINT manual_learning'));
    assert.equal(queries.at(-1).sql, 'RELEASE SAVEPOINT manual_learning');
  });

  it('clears matching pending suggestions when a suggestion is rejected', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
    };

    await rejectSuggestion(client, {
      transactionId: 55,
      fingerprint: 'costco',
      categoryId: 20,
      memberId: 7
    });

    assert.equal(queries.length, 2);
    assert.ok(String(queries[0].sql).includes('INSERT INTO suggestion_rejections'));
    assert.ok(String(queries[1].sql).includes('UPDATE transactions'));
    assert.deepEqual(queries[1].params, ['costco', 20, 55]);
  });

});
