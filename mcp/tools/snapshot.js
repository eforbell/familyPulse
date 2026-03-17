'use strict';

const { assembleFinancialSnapshot } = require('../../lib/magic-actions/context-assembler');

/**
 * get_financial_snapshot — comprehensive household financial position.
 * Liquid balance, credit, investments, net position, savings rate, coverage.
 */
async function getFinancialSnapshot() {
  return await assembleFinancialSnapshot();
}

module.exports = { getFinancialSnapshot };
