'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { app } = require('../server');
const { normalizePaycheckInput } = require('../lib/paychecks');
const { reconcileAllocationsToTransactionAmount } = require('../lib/transaction-allocations');
const { removeTransactionByPlaidId } = require('../lib/sync');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let baseUrl;
let sessionToken;
let parentId;
let firstItemId;
let accountId;
let secondAccountId;
let firstTransactionId;
let secondTransactionId;
let splitPrimaryTransactionId;
let splitSecondaryTransactionId;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${sessionToken}`,
      ...(options.headers || {})
    }
  });
  return { response, body: await response.json() };
}

const paycheck = {
  employer: 'Example Employer',
  gross_earnings: '7000.00',
  federal_tax: '1000.00',
  social_security_tax: '400.00',
  medicare_tax: '100.00',
  retirement_401k: '300.00',
  health_insurance: '100.00',
  other_deductions: [{ name: 'Dental', amount: '100.00' }]
};

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { rows: [parent] } = await pool.query("SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1");
  parentId = parent.id;
  sessionToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [sessionToken, parentId]
  );
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (access_token, item_id, institution_name, status)
     VALUES ('paycheck-test-token', 'paycheck-test-item', 'Paycheck Test Bank', 'good') RETURNING id`
  );
  firstItemId = item.id;
  const { rows: [account] } = await pool.query(
    `INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype)
     VALUES ('paycheck-test-account', $1, 'Paycheck Checking', 'depository', 'checking') RETURNING id`,
    [item.id]
  );
  accountId = account.id;
  const { rows: [secondItem] } = await pool.query(
    `INSERT INTO items (access_token, item_id, institution_name, status)
     VALUES ('paycheck-test-token-two', 'paycheck-test-item-two', 'Paycheck Test Bank Two', 'good') RETURNING id`
  );
  const { rows: [secondAccount] } = await pool.query(
    `INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask)
     VALUES ('paycheck-test-account-two', $1, 'Paycheck Savings', 'depository', 'checking', '2222') RETURNING id`,
    [secondItem.id]
  );
  secondAccountId = secondAccount.id;
  const { rows } = await pool.query(
    `INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, pending, is_transfer, source)
     VALUES
       ('paycheck-test-first', $1, -5000.00, '2098-08-01', 'Example Employer', false, false, 'plaid'),
       ('paycheck-test-second', $1, -5100.00, '2098-08-15', 'Example Employer', false, false, 'plaid')
     RETURNING id, plaid_transaction_id`,
    [accountId]
  );
  firstTransactionId = rows.find(row => row.plaid_transaction_id === 'paycheck-test-first').id;
  secondTransactionId = rows.find(row => row.plaid_transaction_id === 'paycheck-test-second').id;
  const { rows: splitRows } = await pool.query(
    `INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, pending, is_transfer, source)
     VALUES
       ('paycheck-test-split-primary', $1, -5000.00, '2098-09-01', 'Example Employer', false, false, 'plaid'),
       ('paycheck-test-split-secondary', $2, -1000.00, '2098-09-01', 'Example Employer', false, false, 'plaid')
     RETURNING id, plaid_transaction_id`,
    [accountId, secondAccountId]
  );
  splitPrimaryTransactionId = splitRows.find(row => row.plaid_transaction_id === 'paycheck-test-split-primary').id;
  splitSecondaryTransactionId = splitRows.find(row => row.plaid_transaction_id === 'paycheck-test-split-secondary').id;
});

after(async () => {
  await pool.query(
    `DELETE FROM paycheck_events WHERE id IN (
       SELECT pd.paycheck_event_id FROM paycheck_deposits pd
       JOIN transactions t ON t.id = pd.transaction_id
       WHERE t.plaid_transaction_id LIKE 'paycheck-test-%'
     )`
  );
  await pool.query("DELETE FROM items WHERE item_id IN ('paycheck-test-item', 'paycheck-test-item-two')");
  await pool.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

describe('paycheck breakdowns', () => {
  it('validates gross minus deductions against the imported net deposit in cents', () => {
    const normalized = normalizePaycheckInput({ ...paycheck, member_id: parentId }, '-5000.00');
    assert.equal(normalized.netCents, 500000n);
    assert.throws(
      () => normalizePaycheckInput({ ...paycheck, member_id: parentId, gross_earnings: '7000.01' }, '-5000.00'),
      /must match .*imported deposit/
    );
  });

  it('saves payroll facts and creates signed allocations that reconcile to Plaid net pay', async () => {
    const { response, body } = await request(`/api/transactions/${firstTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId })
    });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.paycheck.gross_earnings, '7000.00');
    assert.equal(body.paycheck.source_net_amount, '5000.00');
    assert.equal(body.paycheck.reconciliation_status, 'matched');
    assert.deepEqual(body.paycheck.other_deductions, [{ name: 'Dental', amount: '100.00' }]);

    const { rows } = await pool.query(
      `SELECT c.name, ta.amount::text
       FROM transaction_allocations ta
       JOIN categories c ON c.id = ta.category_id
       WHERE ta.transaction_id = $1
       ORDER BY ta.position`,
      [firstTransactionId]
    );
    assert.deepEqual(rows, [
      { name: 'Gross Pay', amount: '-7000.00' },
      { name: 'Federal Income Tax', amount: '1000.00' },
      { name: 'Social Security Tax', amount: '400.00' },
      { name: 'Medicare Tax', amount: '100.00' },
      { name: '401(k) Contributions', amount: '300.00' },
      { name: 'Health Insurance Premiums', amount: '100.00' },
      { name: 'Other Payroll Deductions', amount: '100.00' }
    ]);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.amount), 0), -5000);

    const detail = await request(`/api/transactions/${firstTransactionId}`);
    assert.equal(detail.body.transaction.paycheck.employer, 'Example Employer');
    assert.equal(detail.body.transaction.is_compound, true);
  });

  it('marks payroll facts for review when Plaid revises the source amount', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE transactions SET amount = -5001.00 WHERE id = $1', [firstTransactionId]);
      await reconcileAllocationsToTransactionAmount(client, firstTransactionId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const detail = await request(`/api/transactions/${firstTransactionId}`);
    assert.equal(detail.body.transaction.paycheck.source_net_amount, '5000.00');
    assert.equal(detail.body.transaction.paycheck.reconciliation_status, 'source_changed');
    const adjustment = detail.body.transaction.category_allocations.find(row => row.category_id === null);
    assert.equal(adjustment.amount, '-1.00');

    const restoreClient = await pool.connect();
    try {
      await restoreClient.query('BEGIN');
      await restoreClient.query('UPDATE transactions SET amount = -5000.00 WHERE id = $1', [firstTransactionId]);
      await reconcileAllocationsToTransactionAmount(restoreClient, firstTransactionId);
      await restoreClient.query('COMMIT');
    } catch (err) {
      await restoreClient.query('ROLLBACK');
      throw err;
    } finally {
      restoreClient.release();
    }
    const restored = await request(`/api/transactions/${firstTransactionId}`);
    assert.equal(restored.body.transaction.paycheck.reconciliation_status, 'matched');
    assert.equal(restored.body.transaction.paycheck.source_net_amount, '5000.00');
    assert.equal(restored.body.transaction.category_allocations.some(row => row.category_id === null), false);

    const signFlipClient = await pool.connect();
    try {
      await signFlipClient.query('BEGIN');
      await signFlipClient.query('UPDATE transactions SET amount = 5000.00 WHERE id = $1', [firstTransactionId]);
      await reconcileAllocationsToTransactionAmount(signFlipClient, firstTransactionId);
      await signFlipClient.query('COMMIT');
    } catch (err) {
      await signFlipClient.query('ROLLBACK');
      throw err;
    } finally {
      signFlipClient.release();
    }
    const signFlipped = await request(`/api/transactions/${firstTransactionId}`);
    assert.equal(signFlipped.body.transaction.paycheck.reconciliation_status, 'source_changed');

    const finalRestoreClient = await pool.connect();
    try {
      await finalRestoreClient.query('BEGIN');
      await finalRestoreClient.query('UPDATE transactions SET amount = -5000.00 WHERE id = $1', [firstTransactionId]);
      await reconcileAllocationsToTransactionAmount(finalRestoreClient, firstTransactionId);
      await finalRestoreClient.query('COMMIT');
    } catch (err) {
      await finalRestoreClient.query('ROLLBACK');
      throw err;
    } finally {
      finalRestoreClient.release();
    }
  });

  it('protects payroll category semantics from category administration', async () => {
    const { rows: [grossCategory] } = await pool.query(
      "SELECT id FROM categories WHERE system_key = 'paycheck.gross_earnings'"
    );
    const reclassified = await request(`/api/categories/${grossCategory.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_income: false })
    });
    assert.equal(reclassified.response.status, 409);
    assert.match(reclassified.body.error, /semantics cannot be changed/i);

    const deleted = await request(`/api/categories/${grossCategory.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 409);
    assert.match(deleted.body.error, /paycheck setup/i);
  });

  it('reuses the latest paycheck for the same member and employer', async () => {
    const { response, body } = await request(`/api/transactions/${secondTransactionId}/paycheck-setup`);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.latest_template.transaction_id, firstTransactionId);
    assert.equal(body.latest_template.retirement_401k, '300.00');

    const mismatch = await request(`/api/transactions/${secondTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId })
    });
    assert.equal(mismatch.response.status, 400);
    assert.match(mismatch.body.error, /must match .*imported deposit/i);

    const adjusted = await request(`/api/transactions/${secondTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId, gross_earnings: '7100.00' })
    });
    assert.equal(adjusted.response.status, 200);
    assert.equal(adjusted.body.paycheck.gross_earnings, '7100.00');
  });

  it('models one pay event across two ACH deposit accounts', async () => {
    const setup = await request(`/api/transactions/${splitPrimaryTransactionId}/paycheck-setup`);
    assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
    assert.ok(setup.body.candidate_deposits.some(row => row.id === splitSecondaryTransactionId));

    const saved = await request(`/api/transactions/${splitPrimaryTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({
        ...paycheck,
        member_id: parentId,
        gross_earnings: '8000.00',
        deposit_transaction_ids: [splitPrimaryTransactionId, splitSecondaryTransactionId],
        deduction_transaction_id: splitPrimaryTransactionId
      })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.paycheck.total_net_amount, '6000.00');
    assert.equal(saved.body.paycheck.deposits.length, 2);
    assert.equal(saved.body.paycheck.deposits.find(row => row.transaction_id === splitPrimaryTransactionId).gross_attribution, '7000.00');
    assert.equal(saved.body.paycheck.deposits.find(row => row.transaction_id === splitSecondaryTransactionId).gross_attribution, '1000.00');

    const { rows } = await pool.query(
      `SELECT ta.transaction_id, c.name, ta.amount::text
       FROM transaction_allocations ta JOIN categories c ON c.id = ta.category_id
       WHERE ta.transaction_id = ANY($1::int[]) ORDER BY ta.transaction_id, ta.position`,
      [[splitPrimaryTransactionId, splitSecondaryTransactionId]]
    );
    assert.equal(rows.filter(row => row.transaction_id === splitPrimaryTransactionId).reduce((sum, row) => sum + Number(row.amount), 0), -5000);
    assert.deepEqual(rows.filter(row => row.transaction_id === splitSecondaryTransactionId).map(row => ({ name: row.name, amount: row.amount })), [
      { name: 'Gross Pay', amount: '-1000.00' }
    ]);

    const secondaryDetail = await request(`/api/transactions/${splitSecondaryTransactionId}`);
    assert.equal(secondaryDetail.body.transaction.paycheck.id, saved.body.paycheck.id);
    assert.equal(secondaryDetail.body.transaction.paycheck.deposits.length, 2);

    await pool.query("UPDATE transactions SET merchant_name = 'BANK TWO PAYROLL' WHERE id = $1", [splitSecondaryTransactionId]);
    const driftedSetup = await request(`/api/transactions/${splitSecondaryTransactionId}/paycheck-setup`);
    assert.ok(driftedSetup.body.candidate_deposits.some(row => row.id === splitPrimaryTransactionId));

    const resaved = await request(`/api/transactions/${splitSecondaryTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({
        ...paycheck,
        member_id: parentId,
        gross_earnings: '8000.00',
        deposit_transaction_ids: [splitSecondaryTransactionId, splitPrimaryTransactionId],
        deduction_transaction_id: splitSecondaryTransactionId
      })
    });
    assert.equal(resaved.response.status, 200);
    assert.equal(resaved.body.paycheck.id, saved.body.paycheck.id);
    assert.equal(resaved.body.paycheck.deposits.find(row => row.transaction_id === splitSecondaryTransactionId).deductions_applied, true);

    const { rows: [income] } = await pool.query("SELECT id FROM categories WHERE name = 'Income'");
    const blockedEdit = await request(`/api/transactions/${splitSecondaryTransactionId}/category`, {
      method: 'PUT', body: JSON.stringify({ category_id: income.id })
    });
    assert.equal(blockedEdit.response.status, 409);
    assert.match(blockedEdit.body.error, /Paycheck Setup/i);
    const stillLinked = await request(`/api/transactions/${splitPrimaryTransactionId}`);
    assert.equal(stillLinked.body.transaction.paycheck.id, saved.body.paycheck.id);

    const deleteClient = await pool.connect();
    try {
      await deleteClient.query('BEGIN');
      await deleteClient.query('DELETE FROM transactions WHERE id = $1', [splitSecondaryTransactionId]);
      await assert.rejects(() => deleteClient.query('COMMIT'), /inconsistent deposit allocations/i);
      await deleteClient.query('ROLLBACK');
    } finally {
      deleteClient.release();
    }
    const protectedEvent = await request(`/api/transactions/${splitSecondaryTransactionId}`);
    assert.equal(protectedEvent.body.transaction.paycheck.id, saved.body.paycheck.id);

    await pool.query("UPDATE items SET status = 'disconnected' WHERE id = $1", [firstItemId]);
    const blockedPurge = await request(`/api/items/${firstItemId}/purge`, { method: 'DELETE' });
    assert.equal(blockedPurge.response.status, 409);
    assert.match(blockedPurge.body.error, /paycheck at another institution/i);
  });

  it('clears stale paycheck facts when allocations are replaced normally', async () => {
    const { rows: [category] } = await pool.query(
      "SELECT id FROM categories WHERE name = 'Income'"
    );
    const recategorized = await request(`/api/transactions/${secondTransactionId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category_id: category.id })
    });
    assert.equal(recategorized.response.status, 200);
    const { rows: [stored] } = await pool.query(
      'SELECT count(*)::int AS count FROM paycheck_deposits WHERE transaction_id = $1',
      [secondTransactionId]
    );
    assert.equal(stored.count, 0);
  });

  it('retains a paycheck transaction and template history when Plaid removes it', async () => {
    const result = await removeTransactionByPlaidId('paycheck-test-first');
    assert.equal(result.retained, true);
    const { rows: [stored] } = await pool.query(
      `SELECT t.source_removed, p.id AS paycheck_id
       FROM transactions t
       JOIN paycheck_deposits p ON p.transaction_id = t.id
       WHERE t.id = $1`,
      [firstTransactionId]
    );
    assert.equal(stored.source_removed, true);
    assert.ok(stored.paycheck_id);
  });

  it('rejects pending, debit, and malformed paycheck inputs', async () => {
    const { rows: [transaction] } = await pool.query(
      `INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, pending, is_transfer, source)
       VALUES ('paycheck-test-pending', $1, -5000.00, '2098-08-20', 'Example Employer', true, false, 'plaid')
       RETURNING id`,
      [accountId]
    );
    const pending = await request(`/api/transactions/${transaction.id}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId })
    });
    assert.equal(pending.response.status, 400);
    assert.match(pending.body.error, /pending deposits/i);
  });
});
