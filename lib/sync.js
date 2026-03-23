'use strict';

const { pool } = require('./db');
const plaid = require('./plaid-client');
const { detectTransfers } = require('./transfer-detection');
const { categorizeMany } = require('./categorization');
const logger = require('./logger');
const {
  deriveLiabilityAccessStatus,
  hasLiabilityAccounts
} = require('./liability-access');

function classifyItemFailure(err) {
  const code = err?.code || 'UNKNOWN';
  if (code === 'ITEM_LOGIN_REQUIRED' || code === 'INVALID_ACCESS_TOKEN') {
    return { status: 'needs_reauth', errorCode: code };
  }

  return { status: 'sync_error', errorCode: code };
}

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
    const { rows: items } = await pool.query(
      `SELECT id, access_token, item_id, sync_cursor, liability_access_status
       FROM items
       WHERE status IN ('good', 'sync_error')`
    );

    for (const item of items) {
      try {
        await syncItem(item, results);
        results.items++;
      } catch (err) {
        logger.error('Item sync failed', { itemId: item.id, error: err.message, code: err.code });
        results.errors.push({ item_id: item.id, error: err.message, code: err.code });

        // Update item status on error
        const failure = classifyItemFailure(err);
        await pool.query(
          'UPDATE items SET status = $1, error_code = $2, updated_at = now() WHERE id = $3',
          [failure.status, failure.errorCode, item.id]
        );
      }
    }

    // Run transfer detection
    const transferResult = await detectTransfers();
    results.transfers_detected = transferResult.total;

    // Run auto-categorization
    const catResult = await categorizeMany();
    results.auto_categorized = catResult.matched;

    // Run recurring detection
    try {
      const { detectRecurringCashflows } = require('./recurring-detector');
      const recurringResult = await detectRecurringCashflows();
      results.recurring_detected = recurringResult.candidates.length;
    } catch (err) {
      logger.error('Recurring detection failed', { error: err.message });
      results.recurring_detected = 0;
    }

    // Run anomaly detection
    const { detectAnomalies } = require('./anomaly-detector');
    const anomalyResult = await detectAnomalies();
    results.anomalies_detected = anomalyResult.total;

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

  let liabilityAccessStatus = deriveLiabilityAccessStatus({
    accounts: accountsData.accounts,
    currentStatus: item.liability_access_status
  });

  // 3. Fetch liabilities for credit/loan items
  const hasLiabilityAccount = hasLiabilityAccounts(accountsData.accounts);
  if (hasLiabilityAccount) {
    const liabilityResult = await plaid.getLiabilities(item.access_token);
    liabilityAccessStatus = deriveLiabilityAccessStatus({
      accounts: accountsData.accounts,
      liabilityErrorCode: liabilityResult.errorCode,
      hasLiabilityData: !!liabilityResult.data?.liabilities,
      currentStatus: item.liability_access_status
    });

    if (liabilityResult.data?.liabilities) {
      // Credit cards
      for (const cc of liabilityResult.data.liabilities.credit || []) {
        if (cc.account_id) {
          await upsertLiability(cc.account_id, {
            balance: cc.last_statement_balance,
            statementBalance: cc.last_statement_balance,
            statementDate: cc.last_statement_issue_date,
            minimumPayment: cc.minimum_payment_amount,
            dueDate: cc.next_payment_due_date,
            lastPaymentAmount: cc.last_payment_amount,
            lastPaymentDate: cc.last_payment_date,
            isOverdue: cc.is_overdue ?? false,
            aprData: cc.aprs ? JSON.stringify(cc.aprs) : null
          });
        }
      }

      // Mortgages
      for (const mtg of liabilityResult.data.liabilities.mortgage || []) {
        if (mtg.account_id) {
          await upsertLiability(mtg.account_id, {
            balance: null, // mortgage balance comes from accountsGet
            statementBalance: mtg.next_monthly_payment,
            statementDate: null,
            minimumPayment: mtg.next_monthly_payment,
            dueDate: mtg.next_payment_due_date,
            lastPaymentAmount: mtg.last_payment_amount,
            lastPaymentDate: mtg.last_payment_date,
            isOverdue: (parseFloat(mtg.past_due_amount) || 0) > 0,
            aprData: mtg.interest_rate ? JSON.stringify(mtg.interest_rate) : null
          });
        }
      }

      // Student loans
      for (const sl of liabilityResult.data.liabilities.student || []) {
        if (sl.account_id) {
          await upsertLiability(sl.account_id, {
            balance: null, // loan balance comes from accountsGet
            statementBalance: sl.minimum_payment_amount,
            statementDate: null,
            minimumPayment: sl.minimum_payment_amount,
            dueDate: sl.next_payment_due_date,
            lastPaymentAmount: sl.last_payment_amount,
            lastPaymentDate: sl.last_payment_date,
            isOverdue: sl.is_overdue ?? false,
            aprData: sl.interest_rate_percentage != null
              ? JSON.stringify({ percentage: sl.interest_rate_percentage })
              : null
          });
        }
      }
    }
  }

  // Update cursor and item status
  await pool.query(
    `UPDATE items
     SET sync_cursor = $1,
         last_sync_at = now(),
         status = $2,
         error_code = NULL,
         liability_access_status = $3,
         updated_at = now()
     WHERE id = $4`,
    [txResult.cursor, 'good', liabilityAccessStatus, item.id]
  );
}

async function upsertAccount(itemId, acct) {
  await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, official_name, type, subtype, mask,
                          current_balance, available_balance, iso_currency_code, sync_status, sync_disabled_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NULL)
    ON CONFLICT (plaid_account_id) DO UPDATE SET
      name = EXCLUDED.name,
      official_name = EXCLUDED.official_name,
      type = EXCLUDED.type,
      subtype = EXCLUDED.subtype,
      mask = EXCLUDED.mask,
      current_balance = EXCLUDED.current_balance,
      available_balance = EXCLUDED.available_balance,
      -- Routine sync should preserve any local owner assignment already chosen in-app.
      owner = COALESCE(accounts.owner, EXCLUDED.owner),
      sync_status = 'active',
      sync_disabled_at = NULL,
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

async function upsertLiability(plaidAccountId, data) {
  await pool.query(`
    UPDATE accounts SET
      current_balance = COALESCE($1, current_balance),
      last_statement_balance = $3,
      last_statement_issue_date = $4,
      minimum_payment_amount = $5,
      next_payment_due_date = $6,
      last_payment_amount = $7,
      last_payment_date = $8,
      is_overdue = COALESCE($9, false),
      apr_data = $10,
      updated_at = now()
    WHERE plaid_account_id = $2
  `, [
    data.balance, plaidAccountId,
    data.statementBalance ?? null,
    data.statementDate ?? null,
    data.minimumPayment ?? null,
    data.dueDate ?? null,
    data.lastPaymentAmount ?? null,
    data.lastPaymentDate ?? null,
    data.isOverdue ?? false,
    data.aprData ?? null
  ]);
}

module.exports = { syncAll, upsertAccount, upsertTransaction, classifyItemFailure };
