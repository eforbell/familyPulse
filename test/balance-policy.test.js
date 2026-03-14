'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBalanceBasis,
  getDepositoryBalanceLabel,
  getAccountBalanceMeta,
  sumAccountBalances
} = require('../lib/balance-policy');

describe('balance-policy', () => {
  it('defaults unknown values to available_preferred', () => {
    assert.equal(normalizeBalanceBasis(null), 'available_preferred');
    assert.equal(normalizeBalanceBasis('not-real'), 'available_preferred');
  });

  it('prefers available balance for depository accounts when present', () => {
    const balance = getAccountBalanceMeta({
      type: 'depository',
      current_balance: '1200.00',
      available_balance: '950.25'
    }, 'available_preferred');

    assert.equal(balance.amount, 950.25);
    assert.equal(balance.kind, 'available');
    assert.equal(balance.label, 'Available');
    assert.equal(balance.ledger_amount, 1200);
  });

  it('falls back to current balance when available balance is missing', () => {
    const balance = getAccountBalanceMeta({
      type: 'depository',
      current_balance: '1200.00',
      available_balance: null
    }, 'available_preferred');

    assert.equal(balance.amount, 1200);
    assert.equal(balance.kind, 'ledger');
  });

  it('keeps investment accounts on current balance even when available balance exists', () => {
    const balance = getAccountBalanceMeta({
      type: 'investment',
      current_balance: '2200.00',
      available_balance: '2000.00'
    }, 'available_preferred');

    assert.equal(balance.amount, 2200);
    assert.equal(balance.kind, 'ledger');
  });

  it('sums mixed cash-like accounts with policy applied only to depository balances', () => {
    const total = sumAccountBalances([
      { type: 'depository', current_balance: '1000.00', available_balance: '850.00' },
      { type: 'investment', current_balance: '2000.00', available_balance: '1500.00' },
      { type: 'credit', current_balance: '300.00', available_balance: null }
    ], 'available_preferred', account => ['depository', 'investment'].includes(account.type));

    assert.equal(total, 2850);
  });

  it('returns the correct depository balance label for each basis', () => {
    assert.equal(getDepositoryBalanceLabel('available_preferred'), 'Available');
    assert.equal(getDepositoryBalanceLabel('current_only'), 'Ledger');
  });
});
