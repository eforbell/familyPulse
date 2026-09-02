'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'transaction-categorization.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const ui = context.window.TransactionCategorizationUI;

describe('shared transaction categorization UI', () => {
  it('renders provenance for automatically categorized transactions', () => {
    const html = ui.renderCategoryLine({
      id: 7, category_id: 2, category_name: '✈️ Travel',
      category_color: '#123456', categorization_source: 'learned'
    });
    assert.match(html, />Travel</);
    assert.match(html, /Categorized by learned/);
  });

  it('renders actionable suggestions only for uncategorized transactions', () => {
    const html = ui.renderCategoryLine({
      id: 42, category_id: null, category_name: null,
      suggested_category_id: 3, suggested_category_name: '🍎 Groceries'
    });
    assert.match(html, /Suggest: Groceries/);
    assert.match(html, /acceptCategorySuggestion\(event, 42\)/);
    assert.match(html, /rejectCategorySuggestion\(event, 42\)/);
  });

  it('escapes category data and preserves contextual badges', () => {
    const html = ui.renderCategoryLine({
      id: 9, category_id: 4, category_name: '<Dining>',
      category_color: '#fff', categorization_source: 'rule'
    }, '<span>Historical</span>');
    assert.match(html, /&lt;Dining&gt;/);
    assert.doesNotMatch(html, /<Dining>/);
    assert.match(html, /<span>Historical<\/span>/);
  });

  it('renders a compact allocation breakdown for split transactions', () => {
    const tx = {
      id: 10,
      is_split: true,
      category_allocations: [
        { category_name: 'Groceries', category_color: '#22c55e', amount: '130.00' },
        { category_name: 'Healthcare', category_color: '#ef4444', amount: '49.10' }
      ]
    };
    const line = ui.renderCategoryLine(tx);
    const detail = ui.renderDetailCategory(tx);
    assert.match(line, /Split/);
    assert.match(line, /Groceries \$130\.00/);
    assert.match(line, /Healthcare \$49\.10/);
    assert.match(detail, /status-tag info/);
  });
});
