'use strict';

const { moneyToCents, centsToMoney, replaceTransactionAllocations } = require('./transaction-allocations');

const FIXED_DEDUCTION_FIELDS = [
  'federal_tax',
  'social_security_tax',
  'medicare_tax',
  'retirement_401k',
  'health_insurance'
];
const MAX_OTHER_DEDUCTIONS = 12;
const MAX_EMPLOYER_LENGTH = 160;
const MAX_DEDUCTION_NAME_LENGTH = 80;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function nonNegativeMoney(value, label) {
  const cents = moneyToCents(value ?? '0');
  if (cents < 0n) throw invalid(`${label} cannot be negative`);
  return cents;
}

function normalizePaycheckInput(input, transactionAmount) {
  const employer = String(input?.employer || '').trim();
  if (!employer) throw invalid('Employer is required');
  if (employer.length > MAX_EMPLOYER_LENGTH) throw invalid(`Employer must be ${MAX_EMPLOYER_LENGTH} characters or fewer`);

  const memberId = Number(input?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw invalid('A valid household member is required');

  const grossCents = nonNegativeMoney(input?.gross_earnings, 'Gross earnings');
  if (grossCents === 0n) throw invalid('Gross earnings must be greater than zero');

  const deductions = {};
  for (const field of FIXED_DEDUCTION_FIELDS) {
    deductions[field] = nonNegativeMoney(input?.[field], field.replaceAll('_', ' '));
  }

  const rawOther = input?.other_deductions ?? [];
  if (!Array.isArray(rawOther)) throw invalid('Other deductions must be a list');
  if (rawOther.length > MAX_OTHER_DEDUCTIONS) throw invalid(`Maximum ${MAX_OTHER_DEDUCTIONS} other deductions`);
  const otherDeductions = rawOther.map((item) => {
    const name = String(item?.name || '').trim();
    if (!name) throw invalid('Each other deduction requires a name');
    if (name.length > MAX_DEDUCTION_NAME_LENGTH) {
      throw invalid(`Other deduction names must be ${MAX_DEDUCTION_NAME_LENGTH} characters or fewer`);
    }
    const cents = nonNegativeMoney(item?.amount, name);
    if (cents === 0n) throw invalid('Other deduction amounts must be greater than zero');
    return { name, cents };
  });

  const transactionCents = moneyToCents(transactionAmount);
  if (transactionCents >= 0n) throw invalid('Paycheck setup is only available for income deposits');
  const deductionCents = Object.values(deductions).reduce((sum, cents) => sum + cents, 0n)
    + otherDeductions.reduce((sum, item) => sum + item.cents, 0n);
  const netCents = grossCents - deductionCents;
  if (netCents !== -transactionCents) {
    throw invalid(
      `Net pay ${centsToMoney(netCents)} must match imported deposit ${centsToMoney(-transactionCents)}`
    );
  }

  return { employer, memberId, grossCents, deductions, otherDeductions, netCents };
}

function serializePaycheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    member_id: row.member_id,
    member_name: row.member_name || null,
    employer: row.employer,
    gross_earnings: row.gross_earnings,
    federal_tax: row.federal_tax,
    social_security_tax: row.social_security_tax,
    medicare_tax: row.medicare_tax,
    retirement_401k: row.retirement_401k,
    health_insurance: row.health_insurance,
    other_deductions: row.other_deductions || [],
    source_net_amount: row.source_net_amount,
    reconciliation_status: row.reconciliation_status,
    transaction_amount: row.transaction_amount,
    transaction_date: row.transaction_date,
    updated_at: row.updated_at
  };
}

async function getPaycheck(client, transactionId) {
  const { rows: [row] } = await client.query(
    `SELECT p.*, fm.name AS member_name, t.amount AS transaction_amount, t.date AS transaction_date
     FROM paychecks p
     JOIN family_members fm ON fm.id = p.member_id
     JOIN transactions t ON t.id = p.transaction_id
     WHERE p.transaction_id = $1`,
    [transactionId]
  );
  return serializePaycheck(row);
}

async function getLatestPaycheckTemplate(client, { memberId, employer, excludeTransactionId = null }) {
  const params = [memberId];
  let employerClause = '';
  if (employer) {
    params.push(String(employer).trim());
    employerClause = `AND lower(p.employer) = lower($${params.length})`;
  }
  if (excludeTransactionId) {
    params.push(excludeTransactionId);
    employerClause += ` AND p.transaction_id <> $${params.length}`;
  }
  const { rows: [row] } = await client.query(
    `SELECT p.*, fm.name AS member_name, t.amount AS transaction_amount, t.date AS transaction_date
     FROM paychecks p
     JOIN family_members fm ON fm.id = p.member_id
     JOIN transactions t ON t.id = p.transaction_id
     WHERE p.member_id = $1 ${employerClause}
     ORDER BY t.date DESC, p.updated_at DESC, p.id DESC
     LIMIT 1`,
    params
  );
  return serializePaycheck(row);
}

async function savePaycheck(client, { transactionId, input, createdBy }) {
  const { rows: [transaction] } = await client.query(
    `SELECT id, amount, pending, is_transfer
     FROM transactions WHERE id = $1 FOR UPDATE`,
    [transactionId]
  );
  if (!transaction) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (transaction.pending) throw invalid('Pending deposits cannot be configured until they post');
  if (transaction.is_transfer) throw invalid('Transfer transactions cannot be configured as paychecks');

  const normalized = normalizePaycheckInput(input, transaction.amount);
  const { rows: members } = await client.query('SELECT id FROM family_members WHERE id = $1', [normalized.memberId]);
  if (!members.length) throw invalid('Household member does not exist');

  const { rows: categoryRows } = await client.query(
    'SELECT field_key, category_id FROM paycheck_category_mappings'
  );
  const categoryByField = Object.fromEntries(categoryRows.map(row => [row.field_key, row.category_id]));
  const requiredFields = ['gross_earnings', ...FIXED_DEDUCTION_FIELDS, 'other_deductions'];
  if (requiredFields.some(field => !categoryByField[field])) {
    throw Object.assign(new Error('Paycheck categories are not configured'), { status: 500 });
  }

  const allocations = [{
    category_id: categoryByField.gross_earnings,
    amount: centsToMoney(-normalized.grossCents)
  }];
  for (const field of FIXED_DEDUCTION_FIELDS) {
    const cents = normalized.deductions[field];
    if (cents > 0n) allocations.push({ category_id: categoryByField[field], amount: centsToMoney(cents) });
  }
  const otherTotal = normalized.otherDeductions.reduce((sum, item) => sum + item.cents, 0n);
  if (otherTotal > 0n) {
    allocations.push({ category_id: categoryByField.other_deductions, amount: centsToMoney(otherTotal) });
  }

  await replaceTransactionAllocations(client, {
    transactionId,
    allocations,
    memberId: createdBy,
    categorizationSource: 'manual'
  });

  const values = FIXED_DEDUCTION_FIELDS.map(field => centsToMoney(normalized.deductions[field]));
  const otherJson = normalized.otherDeductions.map(item => ({ name: item.name, amount: centsToMoney(item.cents) }));
  await client.query(
    `INSERT INTO paychecks (
       transaction_id, member_id, employer, gross_earnings, federal_tax,
       social_security_tax, medicare_tax, retirement_401k, health_insurance,
       other_deductions, source_net_amount, reconciliation_status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'matched',$12)
     ON CONFLICT (transaction_id) DO UPDATE SET
       member_id = EXCLUDED.member_id,
       employer = EXCLUDED.employer,
       gross_earnings = EXCLUDED.gross_earnings,
       federal_tax = EXCLUDED.federal_tax,
       social_security_tax = EXCLUDED.social_security_tax,
       medicare_tax = EXCLUDED.medicare_tax,
       retirement_401k = EXCLUDED.retirement_401k,
       health_insurance = EXCLUDED.health_insurance,
       other_deductions = EXCLUDED.other_deductions,
       source_net_amount = EXCLUDED.source_net_amount,
       reconciliation_status = 'matched',
       updated_at = now()`,
    [
      transactionId, normalized.memberId, normalized.employer, centsToMoney(normalized.grossCents),
      ...values, JSON.stringify(otherJson), centsToMoney(normalized.netCents), createdBy
    ]
  );
  return getPaycheck(client, transactionId);
}

module.exports = {
  FIXED_DEDUCTION_FIELDS,
  MAX_OTHER_DEDUCTIONS,
  normalizePaycheckInput,
  getPaycheck,
  getLatestPaycheckTemplate,
  savePaycheck
};
