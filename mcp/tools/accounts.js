'use strict';

const { pool } = require('../../lib/db');
const { assertNoSecrets } = require('../../lib/secrets-guard');
const {
  getConfiguredBalanceBasis,
  getAccountBalanceMeta
} = require('../../lib/balance-policy');

/**
 * get_account_balances — returns all accounts with balances, grouped by member.
 * Respects household balance policy for depository accounts.
 */
async function getAccountBalances({ member_name } = {}) {
  const { rows: [basisRow] } = await pool.query(
    `SELECT value FROM app_config WHERE key = 'balance_basis'`
  );
  const balanceBasis = basisRow ? basisRow.value : 'available_preferred';

  let query = `
    SELECT a.id, COALESCE(a.custom_name, a.name) AS name,
           a.type, a.subtype, a.mask,
           a.current_balance, a.available_balance,
           COALESCE(a.owner, fm.name) AS owner,
           i.institution_name
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    LEFT JOIN account_members am ON am.account_id = a.id
    LEFT JOIN family_members fm ON am.member_id = fm.id
    WHERE i.status = 'good'`;
  const params = [];

  if (member_name) {
    params.push(member_name);
    query += ` AND (a.owner ILIKE $${params.length} OR fm.name ILIKE $${params.length})`;
  }

  query += ` ORDER BY owner NULLS LAST, a.type, a.name`;

  const { rows } = await pool.query(query, params);
  assertNoSecrets(rows);

  // Group by owner with balance policy applied
  const groups = {};
  for (const acct of rows) {
    const owner = acct.owner || 'Household';
    if (!groups[owner]) groups[owner] = [];

    const balance = getAccountBalanceMeta(acct, balanceBasis);
    groups[owner].push({
      name: acct.name,
      type: acct.type,
      subtype: acct.subtype,
      institution: acct.institution_name,
      balance: balance.amount,
      balance_kind: balance.kind,
      ledger_balance: balance.ledger_amount
    });
  }

  // Compute totals
  let depositoryTotal = 0;
  let creditTotal = 0;
  let investmentTotal = 0;
  for (const acct of rows) {
    const balance = getAccountBalanceMeta(acct, balanceBasis);
    if (acct.type === 'depository') depositoryTotal += balance.amount;
    else if (acct.type === 'credit') creditTotal += parseFloat(acct.current_balance) || 0;
    else if (acct.type === 'investment') investmentTotal += parseFloat(acct.current_balance) || 0;
  }

  return {
    balance_basis: balanceBasis,
    groups,
    totals: {
      depository: Math.round(depositoryTotal * 100) / 100,
      credit: Math.round(creditTotal * 100) / 100,
      investment: Math.round(investmentTotal * 100) / 100,
      net_position: Math.round((depositoryTotal + investmentTotal + creditTotal) * 100) / 100
    },
    account_count: rows.length
  };
}

module.exports = { getAccountBalances };
