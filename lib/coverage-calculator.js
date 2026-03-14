'use strict';

const { pool } = require('./db');
const {
  normalizeBalanceBasis,
  getDepositoryBalanceLabel,
  getAccountBalanceMeta,
  sumAccountBalances
} = require('./balance-policy');

/**
 * Calculate upcoming liability coverage from depository account balances.
 * Coverage = depository_total / obligation_total
 *
 * Credit obligations use statement balance, falling back to current balance.
 * Loan obligations use their payment field only; they never fall back to
 * principal balance because a transactions-only Item can still expose `type=loan`.
 *
 * Status tiers:
 *   clear   — no obligations
 *   healthy — obligations exist, coverage above threshold
 *   warning — coverage consumed at or above threshold (default 70%)
 *   danger  — obligations exceed checking balance
 */
async function getCoverage(options = {}) {
  const balanceBasis = normalizeBalanceBasis(options.balanceBasis);
  const accountIdPrefix = options.accountIdPrefix || null;

  // Get alert threshold from app_config
  const { rows: [thresholdRow] } = await pool.query(
    `SELECT value FROM app_config WHERE key = 'coverage_alert_threshold'`
  );
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0.70;

  // Depository accounts — checking, savings, money market, CD (good items only)
  // Exclude kid-linked accounts from household coverage
  const depositoryParams = [];
  let depositoryFilter = '';
  if (accountIdPrefix) {
    depositoryParams.push(`${accountIdPrefix}%`);
    depositoryFilter = ` AND a.plaid_account_id LIKE $${depositoryParams.length}`;
  }

  const { rows: depositoryRows } = await pool.query(`
    SELECT a.id, COALESCE(a.custom_name, a.name) AS name, a.type, a.subtype, a.current_balance, a.available_balance, a.mask, i.institution_name
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE a.type = 'depository'
      AND i.status = 'good'
      AND a.id NOT IN (
        SELECT am.account_id FROM account_members am
        JOIN family_members fm ON am.member_id = fm.id
        WHERE fm.role = 'kid'
      )
      ${depositoryFilter}
    ORDER BY a.name
  `, depositoryParams);

  // Liability accounts: credit cards, mortgages, student loans (good items only)
  // Exclude kid-linked accounts from household coverage
  const liabilityParams = [];
  let liabilityFilter = '';
  if (accountIdPrefix) {
    liabilityParams.push(`${accountIdPrefix}%`);
    liabilityFilter = ` AND a.plaid_account_id LIKE $${liabilityParams.length}`;
  }

  const { rows: liabilityRows } = await pool.query(`
    SELECT a.id, COALESCE(a.custom_name, a.name) AS name, a.type, a.subtype, a.mask, a.current_balance,
           a.last_statement_balance, a.last_statement_issue_date,
           a.minimum_payment_amount, a.next_payment_due_date,
           a.last_payment_amount, a.last_payment_date,
           a.is_overdue, a.apr_data,
           i.institution_name
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE a.type IN ('credit', 'loan')
      AND i.status = 'good'
      AND a.id NOT IN (
        SELECT am.account_id FROM account_members am
        JOIN family_members fm ON am.member_id = fm.id
        WHERE fm.role = 'kid'
      )
      ${liabilityFilter}
    ORDER BY a.next_payment_due_date ASC NULLS LAST, a.name
  `, liabilityParams);

  const depositoryTotal = sumAccountBalances(depositoryRows, balanceBasis);

  const obligations = liabilityRows.map(c => {
    const statementBal = parseFloat(c.last_statement_balance);
    const currentBal = parseFloat(c.current_balance) || 0;
    const minimumPayment = parseFloat(c.minimum_payment_amount);
    let obligation = null;
    let satisfied = false;

    if (c.type === 'credit') {
      satisfied = !c.is_overdue && !isNaN(minimumPayment) && minimumPayment === 0;
      obligation = satisfied ? 0 : (!isNaN(statementBal) ? statementBal : currentBal);
    } else if (c.type === 'loan') {
      obligation = !isNaN(minimumPayment)
        ? minimumPayment
        : (!isNaN(statementBal) ? statementBal : null);
    }

    return {
      id: c.id,
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      mask: c.mask,
      institution_name: c.institution_name,
      obligation: obligation == null ? null : Math.round(obligation * 100) / 100,
      statement_balance: !isNaN(statementBal) ? Math.round(statementBal * 100) / 100 : null,
      current_balance: Math.round(currentBal * 100) / 100,
      minimum_payment: !isNaN(minimumPayment) ? minimumPayment : null,
      due_date: c.next_payment_due_date || null,
      last_payment_amount: c.last_payment_amount ? parseFloat(c.last_payment_amount) : null,
      last_payment_date: c.last_payment_date || null,
      is_overdue: c.is_overdue || false,
      satisfied,
      missing_liability_data: c.type === 'loan' && obligation == null
    };
  });

  const cards = obligations.filter(c => c.obligation != null || c.satisfied);

  const obligationTotal = cards.reduce((sum, c) => sum + (c.satisfied ? 0 : c.obligation), 0);

  let ratio = null;
  let status;
  if (obligationTotal === 0) {
    status = 'clear';
  } else {
    ratio = Math.round((depositoryTotal / obligationTotal) * 100) / 100;
    const consumed = obligationTotal / depositoryTotal;
    if (depositoryTotal <= 0 || obligationTotal > depositoryTotal) {
      status = 'danger';
    } else if (consumed >= threshold) {
      status = 'warning';
    } else {
      status = 'healthy';
    }
  }

  return {
    balance_basis: balanceBasis,
    depository_balance_label: getDepositoryBalanceLabel(balanceBasis),
    depository_total: Math.round(depositoryTotal * 100) / 100,
    obligation_total: Math.round(obligationTotal * 100) / 100,
    ratio,
    status,
    threshold,
    cards,
    depository_accounts: depositoryRows.map(a => {
      const balance = getAccountBalanceMeta(a, balanceBasis);
      return {
        id: a.id,
        name: a.name,
        mask: a.mask,
        institution_name: a.institution_name,
        balance: balance.amount,
        balance_kind: balance.kind,
        balance_label: balance.label,
        ledger_balance: balance.ledger_amount
      };
    })
  };
}

module.exports = { getCoverage };
