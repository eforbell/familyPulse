'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { app } = require('../server');
const {
  moneyToCents,
  centsToMoney,
  reconcileAllocationsToTransactionAmount
} = require('../lib/transaction-allocations');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server;
let baseUrl;
let accountId;
let expenseTransactionId;
let pendingTransactionId;
let paycheckTransactionId;
let zeroTransactionId;
let transferTransactionId;
let groceriesId;
let healthcareId;
let taxesId;
let incomeId;
let transferId;
let secondTransferId;
let sessionToken;

async function jsonRequest(path, options = {}) {
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

async function updateAmountAndReconcile(transactionId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE transactions SET amount = $1 WHERE id = $2', [amount, transactionId]);
    await reconcileAllocationsToTransactionAmount(client, transactionId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { rows: [parent] } = await pool.query("SELECT id FROM family_members WHERE role = 'parent' LIMIT 1");
  sessionToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (token, member_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [sessionToken, parent.id]
  );
  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_name, status)
    VALUES ('allocation-test-token', 'allocation-test-item', 'Allocation Test Bank', 'good')
    RETURNING id
  `);
  const { rows: [account] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype)
    VALUES ('allocation-test-account', $1, 'Allocation Checking', 'depository', 'checking')
    RETURNING id
  `, [item.id]);
  accountId = account.id;

  const categoryRows = await Promise.all([
    pool.query(`INSERT INTO categories (name, color) VALUES ('Allocation Groceries', '#22c55e') RETURNING id`),
    pool.query(`INSERT INTO categories (name, color) VALUES ('Allocation Healthcare', '#ef4444') RETURNING id`),
    pool.query(`INSERT INTO categories (name, color) VALUES ('Allocation Taxes', '#f59e0b') RETURNING id`),
    pool.query(`INSERT INTO categories (name, color, is_income) VALUES ('Allocation Gross Income', '#10b981', true) RETURNING id`),
    pool.query(`INSERT INTO categories (name, color, is_transfer_class) VALUES ('Allocation Transfer', '#64748b', true) RETURNING id`),
    pool.query(`INSERT INTO categories (name, color, is_transfer_class) VALUES ('Allocation Transfer Two', '#94a3b8', true) RETURNING id`)
  ]);
  [groceriesId, healthcareId, taxesId, incomeId, transferId, secondTransferId] = categoryRows.map(result => result.rows[0].id);

  const { rows } = await pool.query(`
    INSERT INTO transactions
      (plaid_transaction_id, account_id, amount, date, merchant_name, pending, is_transfer, source)
    VALUES
      ('allocation-expense', $1, 179.10, '2098-07-10', 'Costco', false, false, 'test'),
      ('allocation-pending', $1, 50.00, '2098-07-11', 'Pending Store', true, false, 'test'),
      ('allocation-paycheck', $1, -5000.00, '2098-07-12', 'Employer', false, false, 'test'),
      ('allocation-zero', $1, 0.00, '2098-07-13', 'Zero Adjustment', false, false, 'test'),
      ('allocation-transfer-parent', $1, 50.00, '2098-07-14', 'Account Transfer', false, true, 'test')
    RETURNING id, plaid_transaction_id
  `, [accountId]);
  expenseTransactionId = rows.find(row => row.plaid_transaction_id === 'allocation-expense').id;
  pendingTransactionId = rows.find(row => row.plaid_transaction_id === 'allocation-pending').id;
  paycheckTransactionId = rows.find(row => row.plaid_transaction_id === 'allocation-paycheck').id;
  zeroTransactionId = rows.find(row => row.plaid_transaction_id === 'allocation-zero').id;
  transferTransactionId = rows.find(row => row.plaid_transaction_id === 'allocation-transfer-parent').id;
});

after(async () => {
  await pool.query(`DELETE FROM items WHERE item_id = 'allocation-test-item'`);
  await pool.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
  await pool.query(`DELETE FROM categories WHERE name LIKE 'Allocation %'`);
  server.close();
  await pool.end();
});

describe('normalized transaction allocations', () => {
  it('converts exact decimal money without floating-point arithmetic', () => {
    assert.equal(moneyToCents('179.10'), 17910n);
    assert.equal(moneyToCents('-5000.00'), -500000n);
    assert.equal(centsToMoney(-500000n), '-5000.00');
  });

  it('creates one canonical allocation automatically for every transaction', async () => {
    const { rows } = await pool.query(
      'SELECT category_id, amount, position FROM transaction_allocations WHERE transaction_id = $1',
      [expenseTransactionId]
    );
    assert.deepEqual(rows.map(row => ({ ...row, amount: String(row.amount) })), [
      { category_id: null, amount: '179.10', position: 1 }
    ]);
  });

  it('splits a posted transaction and exposes allocations in list and detail APIs', async () => {
    const { response, body } = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '130.00' },
        { category_id: healthcareId, amount: '49.10' }
      ] })
    });
    assert.equal(response.status, 200);
    assert.equal(body.allocations.length, 2);

    const { body: detail } = await jsonRequest(`/api/transactions/${expenseTransactionId}`);
    assert.equal(detail.transaction.is_split, true);
    assert.equal(detail.transaction.category_id, null);
    assert.deepEqual(detail.transaction.category_allocations.map(row => row.category_name), [
      'Allocation Groceries', 'Allocation Healthcare'
    ]);

    const { body: filtered } = await jsonRequest(`/api/transactions?category_id=${groceriesId}`);
    assert.ok(filtered.transactions.some(row => row.id === expenseTransactionId));
    assert.equal(filtered.sum, 130);
  });

  it('rejects totals that do not reconcile, duplicate categories, and pending splits', async () => {
    const mismatch = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '100.00' },
        { category_id: healthcareId, amount: '50.00' }
      ] })
    });
    assert.equal(mismatch.response.status, 400);
    assert.match(mismatch.body.error, /must equal transaction amount/i);

    const duplicate = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '100.00' },
        { category_id: groceriesId, amount: '79.10' }
      ] })
    });
    assert.equal(duplicate.response.status, 400);

    const pending = await jsonRequest(`/api/transactions/${pendingTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '25.00' },
        { category_id: healthcareId, amount: '25.00' }
      ] })
    });
    assert.equal(pending.response.status, 400);
    assert.match(pending.body.error, /post/i);

    const mixedTransferClass = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: transferId, amount: '100.00' },
        { category_id: groceriesId, amount: '79.10' }
      ] })
    });
    assert.equal(mixedTransferClass.response.status, 400);
    assert.match(mixedTransferClass.body.error, /transfer categories cannot be used/i);

    const allTransferClass = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: transferId, amount: '100.00' },
        { category_id: secondTransferId, amount: '79.10' }
      ] })
    });
    assert.equal(allTransferClass.response.status, 400);
    assert.match(allTransferClass.body.error, /transfer categories cannot be used/i);

    const transferParent = await jsonRequest(`/api/transactions/${transferTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '25.00' },
        { category_id: healthcareId, amount: '25.00' }
      ] })
    });
    assert.equal(transferParent.response.status, 400);
    assert.match(transferParent.body.error, /transfer transactions cannot be split/i);
  });

  it('supports signed compound allocations for future gross-paycheck enrichment', async () => {
    const { response } = await jsonRequest(`/api/transactions/${paycheckTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: incomeId, amount: '-7000.00' },
        { category_id: taxesId, amount: '1200.00' },
        { category_id: healthcareId, amount: '800.00' }
      ] })
    });
    assert.equal(response.status, 200);
    const { rows: [balanced] } = await pool.query(
      'SELECT SUM(amount)::text AS total FROM transaction_allocations WHERE transaction_id = $1',
      [paycheckTransactionId]
    );
    assert.equal(balanced.total, '-5000.00');

    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const summary = await getMonthlyBudgetSummary('2098-07');
    // Cashflow totals reflect the $5,000 deposited at the bank, while the
    // allocation categories preserve the $7,000 gross-pay breakdown.
    assert.equal(summary.income.current, 5000);
    assert.equal(summary.spending.actual, 179.1);
    assert.equal(summary.categories.find(category => category.id === taxesId).spent, 1200);
    assert.equal(summary.categories.find(category => category.id === healthcareId).spent, 849.1);
    assert.equal(summary.net_cash_flow.current, 4820.9);
    assert.equal(summary.net_cash_flow.current, summary.income.current - summary.spending.actual);
  });

  it('preserves compound facts and uses an explicit adjustment for source revisions', async () => {
    await updateAmountAndReconcile(paycheckTransactionId, '-5100.00');

    const { rows: revised } = await pool.query(
      `SELECT category_id, amount::text
       FROM transaction_allocations
       WHERE transaction_id = $1
       ORDER BY position`,
      [paycheckTransactionId]
    );
    assert.deepEqual(revised, [
      { category_id: incomeId, amount: '-7000.00' },
      { category_id: taxesId, amount: '1200.00' },
      { category_id: healthcareId, amount: '800.00' },
      { category_id: null, amount: '-100.00' }
    ]);

    const { body: revisedDetail } = await jsonRequest(`/api/transactions/${paycheckTransactionId}`);
    assert.equal(revisedDetail.transaction.is_compound, true);

    const { getMonthlyBudgetSummary } = require('../lib/budget-calculator');
    const revisedSummary = await getMonthlyBudgetSummary('2098-07');
    assert.equal(revisedSummary.net_cash_flow.current, 4920.9);

    const { getBudgetTrends } = require('../lib/budget-calculator');
    const RealDate = global.Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(2098, 6, 15);
        return new RealDate(...args);
      }
      static now() { return new RealDate(2098, 6, 15).getTime(); }
    }
    global.Date = FakeDate;
    try {
      const trends = await getBudgetTrends(1);
      assert.equal(trends.monthly[0].income, 5100);
      assert.equal(trends.monthly[0].spending, 179.1);
      assert.equal(trends.monthly[0].net_cash_flow, 4920.9);
      assert.equal(
        trends.monthly[0].net_cash_flow,
        trends.monthly[0].income - trends.monthly[0].spending
      );
    } finally {
      global.Date = RealDate;
    }

    const roundTrip = await jsonRequest(`/api/transactions/${paycheckTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: revised })
    });
    assert.equal(roundTrip.response.status, 200);
    assert.deepEqual(
      roundTrip.body.allocations.map(row => ({ category_id: row.category_id, amount: row.amount })),
      revised
    );

    await updateAmountAndReconcile(paycheckTransactionId, '-5000.00');
    const { rows: restored } = await pool.query(
      `SELECT category_id, amount::text
       FROM transaction_allocations
       WHERE transaction_id = $1
       ORDER BY position`,
      [paycheckTransactionId]
    );
    assert.deepEqual(restored, revised.slice(0, 3));
  });

  it('uses deposited cash, not gross payroll allocations, in financial-snapshot averages', async () => {
    const { assembleFinancialSnapshot } = require('../lib/magic-actions/context-assembler');
    const RealDate = global.Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(2098, 7, 15);
        return new RealDate(...args);
      }
      static now() { return new RealDate(2098, 7, 15).getTime(); }
    }
    global.Date = FakeDate;
    try {
      const snapshot = await assembleFinancialSnapshot();
      assert.equal(snapshot.avg_monthly_income, 1666.67);
      assert.equal(snapshot.avg_monthly_spending, 59.7);
      assert.equal(snapshot.avg_monthly_savings, 1606.97);
    } finally {
      global.Date = RealDate;
    }
  });

  it('ratio-rebalances an ordinary split across a source sign change', async () => {
    await updateAmountAndReconcile(expenseTransactionId, '0.00');
    const { rows: zeroed } = await pool.query(
      `SELECT category_id, amount::text FROM transaction_allocations
       WHERE transaction_id = $1 ORDER BY position`,
      [expenseTransactionId]
    );
    assert.deepEqual(zeroed, [
      { category_id: groceriesId, amount: '130.00' },
      { category_id: healthcareId, amount: '49.10' },
      { category_id: null, amount: '-179.10' }
    ]);

    await updateAmountAndReconcile(expenseTransactionId, '179.10');
    await updateAmountAndReconcile(expenseTransactionId, '-179.10');
    const { rows: flipped } = await pool.query(
      `SELECT amount::text FROM transaction_allocations
       WHERE transaction_id = $1 ORDER BY position`,
      [expenseTransactionId]
    );
    assert.deepEqual(flipped.map(row => row.amount), ['-130.00', '-49.10']);

    await updateAmountAndReconcile(expenseTransactionId, '179.10');

    await updateAmountAndReconcile(expenseTransactionId, '0.01');
    const { rows: shrunken } = await pool.query(
      `SELECT category_id, amount::text FROM transaction_allocations
       WHERE transaction_id = $1 ORDER BY position`,
      [expenseTransactionId]
    );
    assert.deepEqual(shrunken, [{ category_id: healthcareId, amount: '0.01' }]);

    await updateAmountAndReconcile(expenseTransactionId, '179.10');
    const recreated = await jsonRequest(`/api/transactions/${expenseTransactionId}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations: [
        { category_id: groceriesId, amount: '130.00' },
        { category_id: healthcareId, amount: '49.10' }
      ] })
    });
    assert.equal(recreated.response.status, 200);
  });

  it('enforces the allocation sum invariant at commit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE transaction_allocations SET amount = amount + 1 WHERE transaction_id = $1 AND position = 1',
        [expenseTransactionId]
      );
      await assert.rejects(client.query('COMMIT'), /allocations total/i);
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('requires at least one allocation for zero-amount transactions at commit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM transaction_allocations WHERE transaction_id = $1',
        [zeroTransactionId]
      );
      await assert.rejects(client.query('COMMIT'), /at least one allocation/i);
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }

    const { rows: [result] } = await pool.query(
      'SELECT count(*)::int AS allocation_count FROM transaction_allocations WHERE transaction_id = $1',
      [zeroTransactionId]
    );
    assert.equal(result.allocation_count, 1);
  });

  it('prevents allocations from being reparented to another transaction', async () => {
    await assert.rejects(
      pool.query(
        `UPDATE transaction_allocations
         SET transaction_id = $1
         WHERE transaction_id = $2 AND position = 1`,
        [pendingTransactionId, expenseTransactionId]
      ),
      /cannot move from transaction/i
    );
  });

  it('prevents a split parent from being marked as a transfer', async () => {
    await assert.rejects(
      pool.query('UPDATE transactions SET is_transfer = true WHERE id = $1', [expenseTransactionId]),
      /transfer transaction .* cannot have multiple allocations/i
    );
  });

  it('enforces pending and transfer-category split invariants at commit', async () => {
    const pendingClient = await pool.connect();
    try {
      await pendingClient.query('BEGIN');
      await pendingClient.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [pendingTransactionId]);
      await pendingClient.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
         VALUES ($1, $2, 25.00, 1), ($1, $3, 25.00, 2)`,
        [pendingTransactionId, groceriesId, healthcareId]
      );
      await assert.rejects(pendingClient.query('COMMIT'), /pending transaction .* cannot have multiple allocations/i);
    } finally {
      try { await pendingClient.query('ROLLBACK'); } catch {}
      pendingClient.release();
    }

    const transferCategoryClient = await pool.connect();
    try {
      await transferCategoryClient.query('BEGIN');
      await transferCategoryClient.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [expenseTransactionId]);
      await transferCategoryClient.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
         VALUES ($1, $2, 100.00, 1), ($1, $3, 79.10, 2)`,
        [expenseTransactionId, transferId, secondTransferId]
      );
      await assert.rejects(transferCategoryClient.query('COMMIT'), /cannot use transfer categories in a split/i);
    } finally {
      try { await transferCategoryClient.query('ROLLBACK'); } catch {}
      transferCategoryClient.release();
    }
  });

  it('collapses a split back to one allocation through normal category assignment', async () => {
    const { response } = await jsonRequest(`/api/transactions/${expenseTransactionId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category_id: groceriesId })
    });
    assert.equal(response.status, 200);
    const { rows } = await pool.query(
      'SELECT category_id, amount FROM transaction_allocations WHERE transaction_id = $1',
      [expenseTransactionId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category_id, groceriesId);
    assert.equal(String(rows[0].amount), '179.10');
  });
});
