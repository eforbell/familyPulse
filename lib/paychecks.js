'use strict';

const { moneyToCents, centsToMoney, replaceTransactionAllocations } = require('./transaction-allocations');

const FIXED_DEDUCTION_FIELDS = ['federal_tax', 'social_security_tax', 'medicare_tax', 'retirement_401k', 'health_insurance'];
const MAX_OTHER_DEDUCTIONS = 12;
const MAX_PAYCHECK_DEPOSITS = 8;

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function nonNegativeMoney(value, label) {
  const cents = moneyToCents(value ?? '0');
  if (cents < 0n) throw invalid(`${label} cannot be negative`);
  return cents;
}

function normalizePaycheckInput(input, transactionAmounts) {
  const employer = String(input?.employer || '').trim();
  if (!employer) throw invalid('Employer is required');
  if (employer.length > 160) throw invalid('Employer must be 160 characters or fewer');
  const memberId = Number(input?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw invalid('A valid household member is required');
  const grossCents = nonNegativeMoney(input?.gross_earnings, 'Gross earnings');
  if (grossCents === 0n) throw invalid('Gross earnings must be greater than zero');

  const deductions = {};
  for (const field of FIXED_DEDUCTION_FIELDS) deductions[field] = nonNegativeMoney(input?.[field], field.replaceAll('_', ' '));
  const rawOther = input?.other_deductions ?? [];
  if (!Array.isArray(rawOther)) throw invalid('Other deductions must be a list');
  if (rawOther.length > MAX_OTHER_DEDUCTIONS) throw invalid(`Maximum ${MAX_OTHER_DEDUCTIONS} other deductions`);
  const otherDeductions = rawOther.map(item => {
    const name = String(item?.name || '').trim();
    if (!name || name.length > 80) throw invalid('Each other deduction requires a name of 80 characters or fewer');
    const cents = nonNegativeMoney(item?.amount, name);
    if (cents === 0n) throw invalid('Other deduction amounts must be greater than zero');
    return { name, cents };
  });

  const amounts = Array.isArray(transactionAmounts) ? transactionAmounts : [transactionAmounts];
  const importedNetCents = amounts.reduce((sum, amount) => {
    const value = moneyToCents(amount);
    if (value >= 0n) throw invalid('Paycheck setup is only available for income deposits');
    return sum - value;
  }, 0n);
  const deductionCents = Object.values(deductions).reduce((sum, value) => sum + value, 0n)
    + otherDeductions.reduce((sum, item) => sum + item.cents, 0n);
  const netCents = grossCents - deductionCents;
  if (netCents !== importedNetCents) {
    throw invalid(`Net pay ${centsToMoney(netCents)} must match combined imported deposits ${centsToMoney(importedNetCents)}`);
  }
  return { employer, memberId, grossCents, deductions, otherDeductions, deductionCents, netCents };
}

async function getEventDeposits(client, eventId) {
  const { rows } = await client.query(
    `SELECT pd.id, pd.transaction_id, pd.gross_attribution, pd.deductions_applied,
            pd.source_net_amount, pd.reconciliation_status, pd.position,
            t.amount AS transaction_amount, t.date AS transaction_date,
            COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask,
            COALESCE(t.display_name_override, t.merchant_name, t.name) AS display_name
     FROM paycheck_deposits pd
     JOIN transactions t ON t.id = pd.transaction_id
     JOIN accounts a ON a.id = t.account_id
     WHERE pd.paycheck_event_id = $1 ORDER BY pd.position, pd.id`,
    [eventId]
  );
  return rows;
}

function serializeEvent(row, deposits) {
  if (!row) return null;
  return {
    id: row.id, transaction_id: deposits[0]?.transaction_id || null,
    member_id: row.member_id, member_name: row.member_name || null,
    employer: row.employer, pay_date: row.pay_date, gross_earnings: row.gross_earnings,
    federal_tax: row.federal_tax, social_security_tax: row.social_security_tax,
    medicare_tax: row.medicare_tax, retirement_401k: row.retirement_401k,
    health_insurance: row.health_insurance, other_deductions: row.other_deductions || [],
    source_net_amount: row.total_net_amount, total_net_amount: row.total_net_amount,
    reconciliation_status: deposits.some(row => row.reconciliation_status === 'source_changed') ? 'source_changed' : 'matched',
    deposits, updated_at: row.updated_at
  };
}

async function getPaycheck(client, transactionId) {
  const { rows: [event] } = await client.query(
    `SELECT pe.*, fm.name AS member_name FROM paycheck_events pe
     JOIN family_members fm ON fm.id = pe.member_id
     JOIN paycheck_deposits pd ON pd.paycheck_event_id = pe.id
     WHERE pd.transaction_id = $1`, [transactionId]
  );
  return event ? serializeEvent(event, await getEventDeposits(client, event.id)) : null;
}

async function getLatestPaycheckTemplate(client, { memberId, employer, excludeTransactionId = null }) {
  const params = [memberId];
  const conditions = ['pe.member_id = $1'];
  if (employer) { params.push(String(employer).trim()); conditions.push(`lower(pe.employer) = lower($${params.length})`); }
  if (excludeTransactionId) {
    params.push(excludeTransactionId);
    conditions.push(`NOT EXISTS (SELECT 1 FROM paycheck_deposits x WHERE x.paycheck_event_id = pe.id AND x.transaction_id = $${params.length})`);
  }
  const { rows: [event] } = await client.query(
    `SELECT pe.*, fm.name AS member_name FROM paycheck_events pe
     JOIN family_members fm ON fm.id = pe.member_id
     WHERE ${conditions.join(' AND ')} ORDER BY pe.pay_date DESC, pe.updated_at DESC, pe.id DESC LIMIT 1`, params
  );
  return event ? serializeEvent(event, await getEventDeposits(client, event.id)) : null;
}

async function getCandidateDeposits(client, transactionId) {
  const { rows: [anchor] } = await client.query(
    `SELECT t.id, t.date, pd.paycheck_event_id
     FROM transactions t LEFT JOIN paycheck_deposits pd ON pd.transaction_id = t.id
     WHERE t.id = $1`, [transactionId]
  );
  if (!anchor) return [];
  const { rows } = await client.query(
    `SELECT t.id, t.amount, t.date, COALESCE(t.display_name_override, t.merchant_name, t.name) AS display_name,
            COALESCE(a.custom_name, a.name) AS account_name, a.mask AS account_mask, pd.paycheck_event_id
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN paycheck_deposits pd ON pd.transaction_id = t.id
     WHERE t.amount < 0 AND t.pending = false AND t.is_transfer = false
       AND (t.id = $1 OR t.date BETWEEN $2::date - 3 AND $2::date + 3
         OR ($3::int IS NOT NULL AND pd.paycheck_event_id = $3))
     ORDER BY t.date, t.id`,
    [transactionId, anchor.date, anchor.paycheck_event_id]
  );
  return rows;
}

async function savePaycheck(client, { transactionId, input, createdBy }) {
  const requestedIds = input?.deposit_transaction_ids ?? [transactionId];
  if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > MAX_PAYCHECK_DEPOSITS) {
    throw invalid(`Choose between 1 and ${MAX_PAYCHECK_DEPOSITS} paycheck deposits`);
  }
  const depositIds = [...new Set(requestedIds.map(Number))];
  if (depositIds.length !== requestedIds.length || depositIds.some(id => !Number.isInteger(id) || id <= 0)) throw invalid('Deposit transactions must be unique valid IDs');
  if (!depositIds.includes(transactionId)) throw invalid('The opened transaction must remain part of this paycheck');
  const deductionTransactionId = Number(input?.deduction_transaction_id || transactionId);
  if (!depositIds.includes(deductionTransactionId)) throw invalid('Choose one selected deposit to carry payroll deductions');

  const { rows: transactions } = await client.query(
    `SELECT id, amount, date, pending, is_transfer FROM transactions
     WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [depositIds]
  );
  if (transactions.length !== depositIds.length) throw invalid('One or more deposit transactions do not exist');
  if (transactions.some(tx => tx.pending)) throw invalid('Pending deposits cannot be configured until they post');
  if (transactions.some(tx => tx.is_transfer)) throw invalid('Transfer transactions cannot be configured as paychecks');
  const dates = transactions.map(tx => new Date(`${tx.date}T00:00:00Z`).getTime());
  if (Math.max(...dates) - Math.min(...dates) > 7 * 86400000) throw invalid('Paycheck deposits must post within seven days of each other');

  const { rows: assignedDeposits } = await client.query(
    `SELECT transaction_id, paycheck_event_id FROM paycheck_deposits
     WHERE transaction_id = ANY($1::int[])`, [depositIds]
  );
  const anchorEventId = assignedDeposits.find(row => row.transaction_id === transactionId)?.paycheck_event_id || null;
  if (assignedDeposits.some(row => row.paycheck_event_id !== anchorEventId)) {
    throw invalid('A selected deposit already belongs to another paycheck');
  }

  const normalized = normalizePaycheckInput(input, transactions.map(tx => tx.amount));
  const { rowCount: memberCount } = await client.query('SELECT 1 FROM family_members WHERE id = $1', [normalized.memberId]);
  if (!memberCount) throw invalid('Household member does not exist');
  const { rows: categoryRows } = await client.query('SELECT field_key, category_id FROM paycheck_category_mappings');
  const categoryByField = Object.fromEntries(categoryRows.map(row => [row.field_key, row.category_id]));
  if (['gross_earnings', ...FIXED_DEDUCTION_FIELDS, 'other_deductions'].some(field => !categoryByField[field])) throw new Error('Paycheck categories are not configured');

  const { rows: oldDeposits } = anchorEventId
    ? await client.query('SELECT transaction_id, paycheck_event_id FROM paycheck_deposits WHERE paycheck_event_id = $1', [anchorEventId])
    : { rows: [] };
  for (const old of oldDeposits) {
    if (depositIds.includes(old.transaction_id)) continue;
    const { rows: [removed] } = await client.query('SELECT amount FROM transactions WHERE id = $1', [old.transaction_id]);
    if (removed) await replaceTransactionAllocations(client, {
      transactionId: old.transaction_id,
      allocations: [{ category_id: categoryByField.gross_earnings, amount: removed.amount }],
      memberId: createdBy, categorizationSource: 'manual', preservePaycheck: true
    });
  }

  const transactionById = new Map(transactions.map(tx => [tx.id, tx]));
  const otherTotal = normalized.otherDeductions.reduce((sum, item) => sum + item.cents, 0n);
  const depositModels = [];
  for (const [position, depositId] of depositIds.entries()) {
    const transaction = transactionById.get(depositId);
    const netCents = -moneyToCents(transaction.amount);
    const deductionsApplied = depositId === deductionTransactionId;
    const grossAttribution = netCents + (deductionsApplied ? normalized.deductionCents : 0n);
    const allocations = [{ category_id: categoryByField.gross_earnings, amount: centsToMoney(-grossAttribution) }];
    if (deductionsApplied) {
      for (const field of FIXED_DEDUCTION_FIELDS) if (normalized.deductions[field] > 0n) {
        allocations.push({ category_id: categoryByField[field], amount: centsToMoney(normalized.deductions[field]) });
      }
      if (otherTotal > 0n) allocations.push({ category_id: categoryByField.other_deductions, amount: centsToMoney(otherTotal) });
    }
    await replaceTransactionAllocations(client, {
      transactionId: depositId, allocations, memberId: createdBy,
      categorizationSource: 'manual', preservePaycheck: true
    });
    depositModels.push({ transaction, grossAttribution, deductionsApplied, netCents, position: position + 1 });
  }

  const values = FIXED_DEDUCTION_FIELDS.map(field => centsToMoney(normalized.deductions[field]));
  const otherJson = normalized.otherDeductions.map(item => ({ name: item.name, amount: centsToMoney(item.cents) }));
  const payDate = transactions.map(tx => tx.date).sort().at(-1);
  const eventValues = [normalized.memberId, normalized.employer, payDate, centsToMoney(normalized.grossCents),
    ...values, JSON.stringify(otherJson), centsToMoney(normalized.netCents), createdBy];
  const { rows: [event] } = anchorEventId
    ? await client.query(
      `UPDATE paycheck_events SET member_id=$1, employer=$2, pay_date=$3, gross_earnings=$4,
         federal_tax=$5, social_security_tax=$6, medicare_tax=$7, retirement_401k=$8,
         health_insurance=$9, other_deductions=$10::jsonb, total_net_amount=$11,
         created_by=$12, updated_at=now() WHERE id=$13 RETURNING id`, [...eventValues, anchorEventId]
    )
    : await client.query(
      `INSERT INTO paycheck_events (member_id, employer, pay_date, gross_earnings, federal_tax,
         social_security_tax, medicare_tax, retirement_401k, health_insurance, other_deductions,
         total_net_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id`, eventValues
    );
  if (anchorEventId) await client.query(
    `UPDATE paycheck_deposits
     SET position = position + 100, deductions_applied = false
     WHERE paycheck_event_id = $1`, [event.id]
  );
  for (const deposit of depositModels) await client.query(
    `INSERT INTO paycheck_deposits (paycheck_event_id, transaction_id, gross_attribution,
       deductions_applied, source_net_amount, position) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (transaction_id) DO UPDATE SET paycheck_event_id=EXCLUDED.paycheck_event_id,
       gross_attribution=EXCLUDED.gross_attribution, deductions_applied=EXCLUDED.deductions_applied,
       source_net_amount=EXCLUDED.source_net_amount, reconciliation_status='matched',
       position=EXCLUDED.position, updated_at=now()`,
    [event.id, deposit.transaction.id, centsToMoney(deposit.grossAttribution),
      deposit.deductionsApplied, centsToMoney(deposit.netCents), deposit.position]
  );
  if (anchorEventId) await client.query(
    'DELETE FROM paycheck_deposits WHERE paycheck_event_id = $1 AND transaction_id <> ALL($2::int[])',
    [event.id, depositIds]
  );
  return getPaycheck(client, transactionId);
}

module.exports = { FIXED_DEDUCTION_FIELDS, MAX_OTHER_DEDUCTIONS, MAX_PAYCHECK_DEPOSITS,
  normalizePaycheckInput, getPaycheck, getLatestPaycheckTemplate, getCandidateDeposits, savePaycheck };
