'use strict';

require('dotenv').config();
const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

after(async () => {
  await pool.end();
});

describe('sync — upsert logic', () => {
  let testItemId;
  let testAccountId;

  before(async () => {
    // Create a test item
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-sync', 'test-item-sync', 'ins_test', 'Test Bank Sync', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);
    testItemId = item.id;

    // Create a test account
    const { rows: [acct] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-sync-test', $1, 'Test Checking', 'depository', 'checking', '1234', 1000.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Test Checking'
      RETURNING id
    `, [testItemId]);
    testAccountId = acct.id;
  });

  it('inserts a new transaction', async () => {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, source)
      VALUES ('tx-sync-001', $1, 25.50, '2024-01-15', 'Coffee Shop', false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET
        amount = EXCLUDED.amount, name = EXCLUDED.name, updated_at = now()
    `, [testAccountId]);

    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE plaid_transaction_id = $1', ['tx-sync-001']
    );
    assert.equal(rows.length, 1);
    assert.equal(parseFloat(rows[0].amount), 25.50);
    assert.equal(rows[0].name, 'Coffee Shop');
  });

  it('upserts (updates) an existing transaction', async () => {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, source)
      VALUES ('tx-sync-001', $1, 26.00, '2024-01-15', 'Coffee Shop Updated', false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET
        amount = EXCLUDED.amount, name = EXCLUDED.name, updated_at = now()
    `, [testAccountId]);

    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE plaid_transaction_id = $1', ['tx-sync-001']
    );
    assert.equal(rows.length, 1);
    assert.equal(parseFloat(rows[0].amount), 26.00);
    assert.equal(rows[0].name, 'Coffee Shop Updated');
  });

  it('handles pending → posted transition', async () => {
    // Insert as pending
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, source)
      VALUES ('tx-sync-pending', $1, 50.00, '2024-01-16', 'Pending Purchase', true, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET
        amount = EXCLUDED.amount, pending = EXCLUDED.pending, updated_at = now()
    `, [testAccountId]);

    let { rows } = await pool.query(
      'SELECT pending FROM transactions WHERE plaid_transaction_id = $1', ['tx-sync-pending']
    );
    assert.equal(rows[0].pending, true);

    // Update to posted
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, source)
      VALUES ('tx-sync-pending', $1, 50.00, '2024-01-16', 'Pending Purchase', false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET
        amount = EXCLUDED.amount, pending = EXCLUDED.pending, updated_at = now()
    `, [testAccountId]);

    ({ rows } = await pool.query(
      'SELECT pending FROM transactions WHERE plaid_transaction_id = $1', ['tx-sync-pending']
    ));
    assert.equal(rows[0].pending, false);
  });

  it('deduplicates by plaid_transaction_id', async () => {
    // Insert same tx multiple times
    for (let i = 0; i < 3; i++) {
      await pool.query(`
        INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, source)
        VALUES ('tx-sync-dedup', $1, 100.00, '2024-01-17', 'Dedup Test', false, 'plaid')
        ON CONFLICT (plaid_transaction_id) DO UPDATE SET
          amount = EXCLUDED.amount, updated_at = now()
      `, [testAccountId]);
    }

    const { rows } = await pool.query(
      'SELECT count(*)::int AS count FROM transactions WHERE plaid_transaction_id = $1', ['tx-sync-dedup']
    );
    assert.equal(rows[0].count, 1);
  });

  it('cursor updates on items table', async () => {
    const cursor = 'cursor-abc-123';
    await pool.query(
      'UPDATE items SET sync_cursor = $1, last_sync_at = now() WHERE id = $2',
      [cursor, testItemId]
    );

    const { rows } = await pool.query('SELECT sync_cursor, last_sync_at FROM items WHERE id = $1', [testItemId]);
    assert.equal(rows[0].sync_cursor, cursor);
    assert.ok(rows[0].last_sync_at);
  });

  // Cleanup
  after(async () => {
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'tx-sync-%'");
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-sync-test'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-sync'");
  });
});
