'use strict';

const { getCoverage } = require('../../lib/coverage-calculator');

/**
 * get_coverage — liability coverage ratio and per-card details.
 */
async function getCoverageData() {
  const cov = await getCoverage();

  return {
    balance_basis: cov.balance_basis,
    depository_total: cov.depository_total,
    obligation_total: cov.obligation_total,
    ratio: cov.ratio,
    status: cov.status,
    threshold: cov.threshold,
    cards: cov.cards.map(c => ({
      name: c.name,
      type: c.type,
      obligation: c.obligation,
      statement_balance: c.statement_balance,
      current_balance: c.current_balance,
      minimum_payment: c.minimum_payment,
      due_date: c.due_date,
      is_overdue: c.is_overdue,
      satisfied: c.satisfied
    })),
    depository_accounts: cov.depository_accounts.map(a => ({
      name: a.name,
      balance: a.balance,
      balance_kind: a.balance_kind,
      institution: a.institution_name
    }))
  };
}

module.exports = { getCoverageData };
