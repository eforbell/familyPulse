'use strict';

require('dotenv').config();
const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { syncAll, classifyItemFailure } = require('../lib/sync');
const plaid = require('../lib/plaid-client');
const { LIABILITY_ACCESS_STATUS } = require('../lib/liability-access');
const recurringDetector = require('../lib/recurring-detector');

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

describe('sync — liability field persistence', () => {
  let liabItemId;
  const originalGetAccounts = plaid.getAccounts;
  const originalSyncTransactions = plaid.syncTransactions;
  const originalGetLiabilities = plaid.getLiabilities;

  before(async () => {
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-liab', 'test-item-liab', 'ins_liab', 'Liab Test Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);
    liabItemId = item.id;

    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-liab-cc', $1, 'Test Credit Card', 'credit', 'credit card', '9999', 500.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Test Credit Card'
    `, [liabItemId]);
  });

  after(async () => {
    plaid.getAccounts = originalGetAccounts;
    plaid.syncTransactions = originalSyncTransactions;
    plaid.getLiabilities = originalGetLiabilities;
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-liab-cc'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-liab'");
  });

  it('stores all liability fields on credit account', async () => {
    await pool.query(`
      UPDATE accounts SET
        last_statement_balance = 450.00,
        last_statement_issue_date = '2026-03-01',
        minimum_payment_amount = 25.00,
        next_payment_due_date = '2026-03-25',
        last_payment_amount = 500.00,
        last_payment_date = '2026-02-20',
        is_overdue = false,
        apr_data = $1
      WHERE plaid_account_id = 'acct-liab-cc'
    `, [JSON.stringify([{ apr_percentage: 22.99, apr_type: 'purchase_apr' }])]);

    const { rows: [acct] } = await pool.query(
      `SELECT last_statement_balance, last_statement_issue_date,
              minimum_payment_amount, next_payment_due_date,
              last_payment_amount, last_payment_date,
              is_overdue, apr_data
       FROM accounts WHERE plaid_account_id = 'acct-liab-cc'`
    );

    assert.equal(parseFloat(acct.last_statement_balance), 450);
    assert.equal(parseFloat(acct.minimum_payment_amount), 25);
    assert.equal(parseFloat(acct.last_payment_amount), 500);
    assert.equal(acct.is_overdue, false);
    assert.ok(acct.apr_data);
    assert.equal(acct.apr_data[0].apr_type, 'purchase_apr');
  });

  it('marks liability access missing when Plaid requires additional consent', async () => {
    plaid.getAccounts = async () => ({
      accounts: [{
        account_id: 'acct-liab-cc',
        name: 'Test Credit Card',
        official_name: 'Test Credit Card',
        type: 'credit',
        subtype: 'credit card',
        mask: '9999',
        balances: { current: 500, available: null, iso_currency_code: 'USD' }
      }]
    });
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-liab-missing'
    });
    plaid.getLiabilities = async () => ({
      data: null,
      errorCode: 'ADDITIONAL_CONSENT_REQUIRED'
    });

    await syncAll();

    const { rows: [item] } = await pool.query(
      'SELECT liability_access_status FROM items WHERE id = $1',
      [liabItemId]
    );
    assert.equal(item.liability_access_status, LIABILITY_ACCESS_STATUS.MISSING);
  });

  it('marks liability access enabled when liability fetch succeeds', async () => {
    plaid.getAccounts = async () => ({
      accounts: [{
        account_id: 'acct-liab-cc',
        name: 'Test Credit Card',
        official_name: 'Test Credit Card',
        type: 'credit',
        subtype: 'credit card',
        mask: '9999',
        balances: { current: 500, available: null, iso_currency_code: 'USD' }
      }]
    });
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-liab-enabled'
    });
    plaid.getLiabilities = async () => ({
      data: {
        liabilities: {
          credit: [{
            account_id: 'acct-liab-cc',
            last_statement_balance: 450,
            last_statement_issue_date: '2026-03-01',
            minimum_payment_amount: 25,
            next_payment_due_date: '2026-03-25',
            last_payment_amount: 500,
            last_payment_date: '2026-02-20',
            is_overdue: false,
            aprs: [{ apr_percentage: 22.99, apr_type: 'purchase_apr' }]
          }]
        }
      },
      errorCode: null
    });

    await syncAll();

    const { rows: [item] } = await pool.query(
      'SELECT liability_access_status FROM items WHERE id = $1',
      [liabItemId]
    );
    assert.equal(item.liability_access_status, LIABILITY_ACCESS_STATUS.ENABLED);
  });
});

describe('sync — item failure classification', () => {
  it('marks ITEM_LOGIN_REQUIRED as needs_reauth', () => {
    const result = classifyItemFailure({ code: 'ITEM_LOGIN_REQUIRED' });
    assert.deepEqual(result, {
      status: 'needs_reauth',
      errorCode: 'ITEM_LOGIN_REQUIRED'
    });
  });

  it('marks transient errors as sync_error', () => {
    const result = classifyItemFailure({ code: 'RATE_LIMIT_EXCEEDED' });
    assert.deepEqual(result, {
      status: 'sync_error',
      errorCode: 'RATE_LIMIT_EXCEEDED'
    });
  });
});

describe('sync — disconnected items', () => {
  const originalGetAccounts = plaid.getAccounts;
  const originalSyncTransactions = plaid.syncTransactions;
  const racingItemKey = 'test-item-disconnect-race';
  const racingAccountKey = 'acct-disconnect-race';
  const failingRacingItemKey = 'test-item-disconnect-failure-race';
  const failingRacingAccountKey = 'acct-disconnect-failure-race';
  let activeItemId;
  let disconnectedItemId;

  async function locallyDisconnectItem(itemId, itemKey) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE items
        SET access_token = $1, status = 'disconnected', disconnected_at = now(), updated_at = now()
        WHERE id = $2
      `, [`[DISCONNECTED]:${itemKey}`, itemId]);
      await client.query(`
        UPDATE accounts
        SET sync_status = 'historical', sync_disabled_at = now(), updated_at = now()
        WHERE item_id = $1
      `, [itemId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  before(async () => {
    const { rows: [active] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-active-sync', 'test-item-active-sync', 'ins_active_sync', 'Active Sync Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good', disconnected_at = NULL
      RETURNING id
    `);
    activeItemId = active.id;

    const { rows: [disconnected] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status, disconnected_at)
      VALUES ('[DISCONNECTED]:test-item-disconnected-sync', 'test-item-disconnected-sync', 'ins_disc_sync', 'Disconnected Sync Bank', 'disconnected', now())
      ON CONFLICT (item_id) DO UPDATE SET status = 'disconnected', disconnected_at = now()
      RETURNING id
    `);
    disconnectedItemId = disconnected.id;
  });

  after(async () => {
    plaid.getAccounts = originalGetAccounts;
    plaid.syncTransactions = originalSyncTransactions;
    await pool.query('DELETE FROM accounts WHERE plaid_account_id = $1', [racingAccountKey]);
    await pool.query('DELETE FROM accounts WHERE plaid_account_id = $1', [failingRacingAccountKey]);
    await pool.query('DELETE FROM items WHERE item_id = $1', [racingItemKey]);
    await pool.query('DELETE FROM items WHERE item_id = $1', [failingRacingItemKey]);
    await pool.query("DELETE FROM items WHERE item_id IN ('test-item-active-sync', 'test-item-disconnected-sync')");
  });

  it('skips disconnected items during syncAll', async () => {
    const seenTokens = [];
    plaid.getAccounts = async (accessToken) => {
      seenTokens.push(accessToken);
      return { accounts: [] };
    };
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-test'
    });

    const result = await syncAll();
    assert.ok(result.items >= 1);
    assert.ok(seenTokens.includes('test-token-active-sync'));
    assert.ok(!seenTokens.includes('[DISCONNECTED]:test-item-disconnected-sync'));

    const { rows: [row] } = await pool.query(
      'SELECT status FROM items WHERE id = $1',
      [disconnectedItemId]
    );
    assert.equal(row.status, 'disconnected');
  });

  it('does not let an in-flight sync revive an item after disconnect', async () => {
    const accessToken = 'test-token-disconnect-race';
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ($1, $2, 'ins_disconnect_race', 'Disconnect Race Bank', 'good')
      RETURNING id
    `, [accessToken, racingItemKey]);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ($1, $2, 'Disconnect Race Checking', 'depository', 'checking', '4242', 100)
    `, [racingAccountKey, item.id]);

    let releaseAccountFetch;
    let signalAccountFetchStarted;
    const accountFetchStarted = new Promise((resolve) => { signalAccountFetchStarted = resolve; });
    const accountFetchReleased = new Promise((resolve) => { releaseAccountFetch = resolve; });

    plaid.getAccounts = async (token) => {
      if (token !== accessToken) return { accounts: [] };
      signalAccountFetchStarted();
      await accountFetchReleased;
      return {
        accounts: [{
          account_id: racingAccountKey,
          name: 'Disconnect Race Checking',
          official_name: 'Disconnect Race Checking',
          type: 'depository',
          subtype: 'checking',
          mask: '4242',
          balances: { current: 125, available: 120, iso_currency_code: 'USD' }
        }]
      };
    };
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-disconnect-race'
    });

    const syncPromise = syncAll();
    await accountFetchStarted;
    await locallyDisconnectItem(item.id, racingItemKey);
    releaseAccountFetch();
    await syncPromise;

    const { rows: [itemRow] } = await pool.query(
      'SELECT access_token, status, disconnected_at FROM items WHERE id = $1',
      [item.id]
    );
    assert.equal(itemRow.access_token, `[DISCONNECTED]:${racingItemKey}`);
    assert.equal(itemRow.status, 'disconnected');
    assert.ok(itemRow.disconnected_at);

    const { rows: [accountRow] } = await pool.query(
      'SELECT sync_status, sync_disabled_at FROM accounts WHERE plaid_account_id = $1',
      [racingAccountKey]
    );
    assert.equal(accountRow.sync_status, 'historical');
    assert.ok(accountRow.sync_disabled_at);
  });

  it('does not let an in-flight sync failure overwrite a disconnect', async () => {
    const accessToken = 'test-token-disconnect-failure-race';
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ($1, $2, 'ins_disconnect_failure_race', 'Disconnect Failure Race Bank', 'good')
      RETURNING id
    `, [accessToken, failingRacingItemKey]);
    await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ($1, $2, 'Failure Race Checking', 'depository', 'checking', '4343', 100)
    `, [failingRacingAccountKey, item.id]);

    plaid.getAccounts = async (token) => {
      if (token !== accessToken) return { accounts: [] };
      await locallyDisconnectItem(item.id, failingRacingItemKey);
      return {
        accounts: [{
          account_id: failingRacingAccountKey,
          name: 'Failure Race Checking',
          official_name: 'Failure Race Checking',
          type: 'depository',
          subtype: 'checking',
          mask: '4343',
          balances: { current: 150, available: 145, iso_currency_code: 'USD' }
        }]
      };
    };
    plaid.syncTransactions = async (token) => {
      if (token === accessToken) {
        const err = new Error('Stale sync failed after disconnect');
        err.code = 'INSTITUTION_NOT_RESPONDING';
        throw err;
      }
      return { added: [], modified: [], removed: [], cursor: 'cursor-other-item' };
    };

    const result = await syncAll();
    assert.equal(result.errors.some((entry) => entry.item_id === item.id), false);

    const { rows: [itemRow] } = await pool.query(
      'SELECT access_token, status, error_code FROM items WHERE id = $1',
      [item.id]
    );
    assert.equal(itemRow.access_token, `[DISCONNECTED]:${failingRacingItemKey}`);
    assert.equal(itemRow.status, 'disconnected');
    assert.equal(itemRow.error_code, null);

    const { rows: [accountRow] } = await pool.query(
      'SELECT sync_status, sync_disabled_at FROM accounts WHERE plaid_account_id = $1',
      [failingRacingAccountKey]
    );
    assert.equal(accountRow.sync_status, 'historical');
    assert.ok(accountRow.sync_disabled_at);
  });
});

describe('sync — recurring detection integration', () => {
  const originalGetAccounts = plaid.getAccounts;
  const originalSyncTransactions = plaid.syncTransactions;
  const originalDetectRecurringCashflows = recurringDetector.detectRecurringCashflows;
  let recurringItemId;

  before(async () => {
    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-recurring-sync', 'test-item-recurring-sync', 'ins_recurring_sync', 'Recurring Sync Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);
    recurringItemId = item.id;
  });

  after(async () => {
    plaid.getAccounts = originalGetAccounts;
    plaid.syncTransactions = originalSyncTransactions;
    recurringDetector.detectRecurringCashflows = originalDetectRecurringCashflows;
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-recurring-sync'");
  });

  it('includes recurring_detected in sync results', async () => {
    plaid.getAccounts = async () => ({ accounts: [] });
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-recurring-sync'
    });
    recurringDetector.detectRecurringCashflows = async () => ({ candidates: [{ id: 1 }, { id: 2 }] });

    const result = await syncAll();
    assert.equal(result.recurring_detected, 2);
  });

  it('isolates recurring detection failures from sync success', async () => {
    plaid.getAccounts = async () => ({ accounts: [] });
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-recurring-sync-fail'
    });
    recurringDetector.detectRecurringCashflows = async () => {
      throw new Error('Recurring detector boom');
    };

    const result = await syncAll();
    assert.equal(result.recurring_detected, 0);
    assert.ok(result.items >= 1);
  });

  it('passes forceFullScan to recurring detection when a full rescan is requested', async () => {
    plaid.getAccounts = async () => ({ accounts: [] });
    plaid.syncTransactions = async () => ({
      added: [],
      modified: [],
      removed: [],
      cursor: 'cursor-recurring-sync-rescan'
    });
    let receivedOptions = null;
    recurringDetector.detectRecurringCashflows = async (options = {}) => {
      receivedOptions = options;
      return { candidates: [] };
    };

    await syncAll(); // default: incremental
    assert.equal(receivedOptions.forceFullScan, undefined);

    await syncAll({ forceRecurringFullScan: true });
    assert.equal(receivedOptions.forceFullScan, true);
  });
});
