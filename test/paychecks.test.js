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
let accountId;
let firstTransactionId;
let secondTransactionId;

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
  const { rows: [account] } = await pool.query(
    `INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype)
     VALUES ('paycheck-test-account', $1, 'Paycheck Checking', 'depository', 'checking') RETURNING id`,
    [item.id]
  );
  accountId = account.id;
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
});

after(async () => {
  await pool.query("DELETE FROM items WHERE item_id = 'paycheck-test-item'");
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
      /must match imported deposit/
    );
  });

  it('saves payroll facts and creates signed allocations that reconcile to Plaid net pay', async () => {
    const { response, body } = await request(`/api/transactions/${firstTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId })
    });
    assert.equal(response.status, 200);
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
    assert.equal(response.status, 200);
    assert.equal(body.latest_template.transaction_id, firstTransactionId);
    assert.equal(body.latest_template.retirement_401k, '300.00');

    const mismatch = await request(`/api/transactions/${secondTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId })
    });
    assert.equal(mismatch.response.status, 400);
    assert.match(mismatch.body.error, /must match imported deposit/i);

    const adjusted = await request(`/api/transactions/${secondTransactionId}/paycheck`, {
      method: 'PUT',
      body: JSON.stringify({ ...paycheck, member_id: parentId, gross_earnings: '7100.00' })
    });
    assert.equal(adjusted.response.status, 200);
    assert.equal(adjusted.body.paycheck.gross_earnings, '7100.00');
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
      'SELECT count(*)::int AS count FROM paychecks WHERE transaction_id = $1',
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
       JOIN paychecks p ON p.transaction_id = t.id
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
