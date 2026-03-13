'use strict';

const { pool } = require('./db');

/**
 * Calculate credit card statement coverage from depository account balances.
 * Coverage = depository_total / obligation_total
 *
 * Status tiers:
 *   clear   — no obligations
 *   healthy — obligations exist, coverage above threshold
 *   warning — coverage consumed at or above threshold (default 70%)
 *   danger  — obligations exceed checking balance
 */
async function getCoverage() {
  // Get alert threshold from app_config
  const { rows: [thresholdRow] } = await pool.query(
    `SELECT value FROM app_config WHERE key = 'coverage_alert_threshold'`
  );
  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : 0.70;

  // Depository accounts — checking, savings, money market, CD (good items only)
  const { rows: depositoryRows } = await pool.query(`
    SELECT a.id, a.name, a.subtype, a.current_balance, a.mask, i.institution_name
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE a.type = 'depository'
      AND i.status = 'good'
    ORDER BY a.name
  `);

  // Credit cards with liability data (good items only)
  const { rows: creditRows } = await pool.query(`
    SELECT a.id, a.name, a.mask, a.current_balance,
           a.last_statement_balance, a.last_statement_issue_date,
           a.minimum_payment_amount, a.next_payment_due_date,
           a.last_payment_amount, a.last_payment_date,
           a.is_overdue, a.apr_data,
           i.institution_name
    FROM accounts a
    JOIN items i ON a.item_id = i.id
    WHERE a.type = 'credit'
      AND i.status = 'good'
    ORDER BY a.next_payment_due_date ASC NULLS LAST, a.name
  `);

  const depositoryTotal = depositoryRows.reduce(
    (sum, a) => sum + (parseFloat(a.current_balance) || 0), 0
  );

  // Obligation = statement balance, falling back to current_balance
  const cards = creditRows.map(c => {
    const statementBal = parseFloat(c.last_statement_balance);
    const currentBal = parseFloat(c.current_balance) || 0;
    const obligation = !isNaN(statementBal) ? statementBal : currentBal;
    return {
      id: c.id,
      name: c.name,
      mask: c.mask,
      institution_name: c.institution_name,
      obligation: Math.round(obligation * 100) / 100,
      statement_balance: !isNaN(statementBal) ? Math.round(statementBal * 100) / 100 : null,
      current_balance: Math.round(currentBal * 100) / 100,
      minimum_payment: c.minimum_payment_amount ? parseFloat(c.minimum_payment_amount) : null,
      due_date: c.next_payment_due_date || null,
      last_payment_amount: c.last_payment_amount ? parseFloat(c.last_payment_amount) : null,
      last_payment_date: c.last_payment_date || null,
      is_overdue: c.is_overdue || false
    };
  });

  const obligationTotal = cards.reduce((sum, c) => sum + c.obligation, 0);

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
    depository_total: Math.round(depositoryTotal * 100) / 100,
    obligation_total: Math.round(obligationTotal * 100) / 100,
    ratio,
    status,
    threshold,
    cards,
    depository_accounts: depositoryRows.map(a => ({
      id: a.id,
      name: a.name,
      mask: a.mask,
      institution_name: a.institution_name,
      balance: Math.round((parseFloat(a.current_balance) || 0) * 100) / 100
    }))
  };
}

module.exports = { getCoverage };
