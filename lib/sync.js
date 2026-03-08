'use strict';

const { pool } = require('./db');
const plaid = require('./plaid-client');
const { detectTransfers } = require('./transfer-detection');
const logger = require('./logger');

/**
 * syncAll — orchestrates a full sync cycle across all Plaid Items.
 * 1. For each Item: fetch accounts, update balances
 * 2. For each Item: sync transactions (cursor-based)
 * 3. For credit-type Items: fetch liabilities
 * 4. Run transfer detection
 * 5. Update last_sync_at
 */
async function syncAll() {
  const startedAt = new Date();
  logger.info('Sync started');

  // Create import run record
  const { rows: [run] } = await pool.query(
    `INSERT INTO import_runs (source, status, started_at) VALUES ('plaid', 'running', $1) RETURNING id`,
    [startedAt]
  );

  const results = {
    items: 0,
    accounts_updated: 0,
    txns_added: 0,
    txns_modified: 0,
    txns_removed: 0,
    errors: []
  };

  try {
    const { rows: items } = await pool.query('SELECT id, access_token, item_id, sync_cursor FROM items WHERE status != $1', ['error']);

    for (const item of items) {
      try {
        await syncItem(item, results);
        results.items++;
      } catch (err) {
        logger.error('Item sync failed', { itemId: item.id, error: err.message, code: err.code });
        results.errors.push({ item_id: item.id, error: err.message, code: err.code });

        // Update item status on error
        await pool.query(
          'UPDATE items SET status = $1, error_code = $2, updated_at = now() WHERE id = $3',
          ['error', err.code || 'UNKNOWN', item.id]
        );
      }
    }

    // Run transfer detection
    const transferResult = await detectTransfers();
    results.transfers_detected = transferResult.total;

    // Finalize import run
    await pool.query(`
      UPDATE import_runs
      SET status = 'complete', items_synced = $1, txns_added = $2, txns_modified = $3,
          txns_removed = $4, errors = $5, finished_at = now()
      WHERE id = $6
    `, [results.items, results.txns_added, results.txns_modified, results.txns_removed,
        results.errors.length > 0 ? JSON.stringify(results.errors) : null, run.id]);

    logger.info('Sync complete', results);
    return results;

  } catch (err) {
    await pool.query(
      `UPDATE import_runs SET status = 'failed', errors = $1, finished_at = now() WHERE id = $2`,
      [JSON.stringify([{ error: err.message }]), run.id]
    );
    throw err;
  }
}

async function syncItem(item, results) {
  // 1. Fetch and update accounts
  const accountsData = await plaid.getAccounts(item.access_token);
  for (const acct of accountsData.accounts) {
    await upsertAccount(item.id, acct);
    results.accounts_updated++;
  }

  // 2. Sync transactions
  const txResult = await plaid.syncTransactions(item.access_token, item.sync_cursor);

  // Process added transactions
  for (const tx of txResult.added) {
    await upsertTransaction(item.id, tx);
    results.txns_added++;
  }

  // Process modified transactions
  for (const tx of txResult.modified) {
    await upsertTransaction(item.id, tx);
    results.txns_modified++;
  }

  // Process removed transactions
  for (const removed of txResult.removed) {
    await pool.query(
      'DELETE FROM transactions WHERE plaid_transaction_id = $1',
      [removed.transaction_id]
    );
    results.txns_removed++;
  }

  // Update cursor
  await pool.query(
    'UPDATE items SET sync_cursor = $1, last_sync_at = now(), status = $2, error_code = NULL, updated_at = now() WHERE id = $3',
    [txResult.cursor, 'good', item.id]
  );

  // 3. Fetch liabilities for credit items
  const hasCreditAccount = accountsData.accounts.some(a => a.type === 'credit');
  if (hasCreditAccount) {
    const liabilities = await plaid.getLiabilities(item.access_token);
    if (liabilities?.liabilities?.credit) {
      for (const cc of liabilities.liabilities.credit) {
        if (cc.account_id) {
          await pool.query(`
            UPDATE accounts SET
              current_balance = COALESCE($1, current_balance),
              updated_at = now()
            WHERE plaid_account_id = $2
          `, [cc.last_statement_balance, cc.account_id]);
        }
      }
    }
  }
}

async function upsertAccount(itemId, acct) {
  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, official_name, type, subtype, mask,
                          current_balance, available_balance, iso_currency_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      name = EXCLUDED.name,
      official_name = EXCLUDED.official_name,
      current_balance = EXCLUDED.current_balance,
      available_balance = EXCLUDED.available_balance,
      updated_at = now()
  `, [
    acct.account_id, itemId, acct.name, acct.official_name,
    acct.type, acct.subtype, acct.mask,
    acct.balances.current, acct.balances.available,
    acct.balances.iso_currency_code || 'USD'
  ]);
}

async function upsertTransaction(itemId, tx) {
  // Resolve account_id from plaid_account_id
  const { rows } = await pool.query(
    'SELECT id FROM accounts WHERE plaid_account_id = $1',
    [tx.account_id]
  );
  if (rows.length === 0) {
    logger.warn('Transaction references unknown account', { plaidAccountId: tx.account_id });
    return;
  }
  const accountId = rows[0].id;

  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, authorized_date,
                              merchant_name, name, plaid_category, pending, iso_currency_code,
                              source, raw_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'plaid', $11)
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      date = EXCLUDED.date,
      authorized_date = EXCLUDED.authorized_date,
      merchant_name = EXCLUDED.merchant_name,
      name = EXCLUDED.name,
      plaid_category = EXCLUDED.plaid_category,
      pending = EXCLUDED.pending,
      raw_json = EXCLUDED.raw_json,
      updated_at = now()
  `, [
    tx.transaction_id, accountId, tx.amount, tx.date, tx.authorized_date,
    tx.merchant_name, tx.name,
    tx.personal_finance_category ? JSON.stringify(tx.personal_finance_category) : null,
    tx.pending, tx.iso_currency_code || 'USD',
    JSON.stringify(tx)
  ]);
}

module.exports = { syncAll, upsertAccount, upsertTransaction };
