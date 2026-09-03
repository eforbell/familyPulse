'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'transactions.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'paycheck-setup.js'), 'utf8');

describe('paycheck setup UI', () => {
  it('offers the required payroll fields and a reusable-template action', () => {
    for (const label of [
      'Gross earnings', 'Federal tax withheld', 'Social Security payroll tax',
      'Medicare tax', '401(k) deduction', 'Health insurance premium', 'Other deductions'
    ]) assert.match(html, new RegExp(label.replace(/[()]/g, '\\$&')));
    assert.match(html, /Use latest paycheck/);
    assert.match(html, /Deposit accounts/);
    assert.match(html, /Apply deductions to/);
  });

  it('keeps money inputs at iOS-safe sizing and requires net reconciliation', () => {
    assert.match(js, /difference !== 0/);
    assert.match(js, /paycheck-save/);
    assert.match(js, /other_deductions/);
    assert.match(js, /deposit_transaction_ids/);
    assert.match(js, /deduction_transaction_id/);
  });

  it('renders the shared amount formatter as markup instead of escaped text', () => {
    assert.match(js, /\$\('paycheck-imported-net'\)\.innerHTML = fmtTxAmount/);
    assert.doesNotMatch(js, /\$\('paycheck-imported-net'\)\.textContent = fmtTxAmount/);
  });

  it('closes the topmost paycheck modal on Escape without orphaning it', () => {
    assert.match(js, /event\.stopImmediatePropagation\(\)/);
    assert.match(js, /event\.key !== 'Escape'/);
    assert.match(js, /closePaycheckSetup\(\)/);
  });
});
