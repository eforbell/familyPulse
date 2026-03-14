'use strict';

const DEFAULT_BALANCE_BASIS = 'available_preferred';
const VALID_BALANCE_BASES = new Set([DEFAULT_BALANCE_BASIS, 'current_only']);

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function parseMoney(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBalanceBasis(value) {
  return VALID_BALANCE_BASES.has(value) ? value : DEFAULT_BALANCE_BASIS;
}

async function getConfiguredBalanceBasis(cfg) {
  return normalizeBalanceBasis(cfg ? await cfg('balance_basis') : null);
}

function getDepositoryBalanceLabel(balanceBasis) {
  return normalizeBalanceBasis(balanceBasis) === 'current_only' ? 'Ledger' : 'Available';
}

function getAccountBalanceMeta(account, balanceBasis) {
  const basis = normalizeBalanceBasis(balanceBasis);
  const currentBalance = roundMoney(parseMoney(account.current_balance));
  const availableBalance = parseOptionalMoney(account.available_balance);
  const normalizedAvailable = availableBalance === null ? null : roundMoney(availableBalance);

  if (account.type === 'depository' && basis === 'available_preferred' && normalizedAvailable !== null) {
    return {
      amount: normalizedAvailable,
      kind: 'available',
      label: 'Available',
      ledger_amount: currentBalance,
      available_amount: normalizedAvailable
    };
  }

  return {
    amount: currentBalance,
    kind: 'ledger',
    label: 'Ledger',
    ledger_amount: currentBalance,
    available_amount: normalizedAvailable
  };
}

function sumAccountBalances(accounts, balanceBasis, predicate = () => true) {
  let total = 0;
  for (const account of accounts) {
    if (!predicate(account)) continue;
    total += getAccountBalanceMeta(account, balanceBasis).amount;
  }
  return roundMoney(total);
}

module.exports = {
  DEFAULT_BALANCE_BASIS,
  VALID_BALANCE_BASES,
  normalizeBalanceBasis,
  getConfiguredBalanceBasis,
  getDepositoryBalanceLabel,
  getAccountBalanceMeta,
  sumAccountBalances
};
