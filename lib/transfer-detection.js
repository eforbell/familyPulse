'use strict';

const { pool, withTransaction } = require('./db');
const logger = require('./logger');
const { categorizeTransaction } = require('./categorization');

// ── CC payment payee patterns ────────────────────────────────
const CC_PAYMENT_PATTERNS = [
  'payment thank you',
  'automatic payment',
  'online payment',
  'autopay',
  'payment - thank',
  'credit card payment',
  'card payment',
  'balance payment'
];

// ── Crypto / BTC patterns ────────────────────────────────────
const CRYPTO_PATTERNS = ['coinbase', 'swan', 'strike', 'cash app bitcoin', 'river financial'];

// ── 529 patterns ─────────────────────────────────────────────
const COLLEGE_529_PATTERNS = ['529', 'college savings', 'education savings', 'ugma', 'ny saves'];

// A transaction detection may flag, as SQL over alias `t`. The category
// decides (bug #168): never flag a transaction someone categorized by hand,
// or one already in a non-transfer category. UNSPLIT: transfers can't be split.
const DETECTABLE = `
  t.is_transfer = false AND t.pending = false AND t.is_hidden = false
  AND COALESCE(t.categorization_source, '') <> 'manual'
  AND NOT EXISTS (
    SELECT 1
    FROM transaction_allocations ta
    JOIN categories c ON c.id = ta.category_id
    WHERE ta.transaction_id = t.id
      AND c.is_transfer_class = false
      AND c.name <> 'Uncategorized'
  )`;
const UNSPLIT = '(SELECT count(*) FROM transaction_allocations ta WHERE ta.transaction_id = t.id) <= 1';

/**
 * detectTransfers — runs transfer detection on recent transactions.
 * Idempotent: skips already-flagged transactions.
 */
async function detectTransfers(windowDays = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  logger.info('Transfer detection started', { windowDays, cutoff: cutoffStr });

  const results = {
    inter_account: 0,
    cc_payment: 0,
    crypto: 0,
    college_529: 0,
    total: 0
  };

  // Fetch recent unflagged transactions
  const { rows: candidates } = await pool.query(`
    SELECT t.id, t.amount, t.date, t.merchant_name, t.name, t.account_id, t.pending,
           a.type AS account_type, a.plaid_account_id
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.date >= $1 AND ${DETECTABLE}
    ORDER BY t.date DESC
  `, [cutoffStr]);
  const txns = await withoutRuleSpending(candidates);

  // 1. Inter-account transfers
  results.inter_account = await detectInterAccount(txns);

  // 2. CC payments
  results.cc_payment = await detectCCPayments(txns);

  // 3. Crypto/BTC
  results.crypto = await detectByPattern(txns, CRYPTO_PATTERNS, 'crypto_savings');

  // 4. 529 contributions
  results.college_529 = await detectByPattern(txns, COLLEGE_529_PATTERNS, '529_contribution');

  // Category rules that point at transfer categories are applied by
  // categorization, which sets the transfer flag with the category.

  results.total = results.inter_account + results.cc_payment + results.crypto + results.college_529;
  logger.info('Transfer detection complete', results);
  return results;
}

/**
 * Detection runs before categorization in a sync, so leave out any transaction
 * one of the household's category rules is about to put in a non-transfer
 * category: the rule decides, not a built-in pattern (bug #168).
 */
async function withoutRuleSpending(txns) {
  const { rows: rules } = await pool.query(`
    SELECT cr.id, cr.merchant_pattern, cr.category_id, cr.match_type, c.is_transfer_class
    FROM category_rules cr
    JOIN categories c ON c.id = cr.category_id
    ORDER BY cr.match_type, cr.id
  `);
  if (rules.length === 0) return txns;
  const transferClass = new Map(rules.map(rule => [rule.category_id, rule.is_transfer_class]));
  return txns.filter(tx => {
    const categoryId = categorizeTransaction(tx, rules);
    return !categoryId || transferClass.get(categoryId);
  });
}

/**
 * Inter-account: same |amount| ±tolerance, opposite signs, within date window, different accounts
 */
function isCashAccount(accountType) {
  return accountType === 'depository';
}

async function detectInterAccount(txns) {
  let count = 0;

  // Load config
  const { rows: cfgRows } = await pool.query(
    "SELECT key, value FROM app_config WHERE key IN ('transfer_amount_tolerance', 'transfer_date_tolerance_days')"
  );
  const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
  const amtTolerance = parseFloat(cfg.transfer_amount_tolerance || '1.00');
  const daysTolerance = parseInt(cfg.transfer_date_tolerance_days || '3', 10);

  for (let i = 0; i < txns.length; i++) {
    const a = txns[i];
    if (a._matched) continue;
    if (!isCashAccount(a.account_type)) continue;

    for (let j = i + 1; j < txns.length; j++) {
      const b = txns[j];
      if (b._matched) continue;
      if (!isCashAccount(b.account_type)) continue;
      if (a.account_id === b.account_id) continue;

      // Opposite signs
      if (Math.sign(a.amount) === Math.sign(b.amount)) continue;

      // Amount match within tolerance
      const diff = Math.abs(Math.abs(a.amount) - Math.abs(b.amount));
      if (diff > amtTolerance) continue;

      // Date match within tolerance
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      const daysDiff = Math.abs(dateA - dateB) / (1000 * 60 * 60 * 24);
      if (daysDiff > daysTolerance) continue;

      // Mark both as transfers
      if (await markTransferPair(a.id, b.id)) {
        a._matched = true;
        b._matched = true;
        count += 2;
        break;
      }
    }
  }

  return count;
}

/**
 * CC payments: payee pattern match on transactions from checking/depository accounts
 */
async function detectCCPayments(txns) {
  let count = 0;

  for (const tx of txns) {
    if (tx._matched) continue;
    const nameLC = (tx.name || '').toLowerCase();
    const merchantLC = (tx.merchant_name || '').toLowerCase();
    const combined = nameLC + ' ' + merchantLC;

    const isCC = CC_PAYMENT_PATTERNS.some(p => combined.includes(p));
    if (isCC && await markTransfer(tx.id, 'cc_payment', null)) {
      tx._matched = true;
      count++;
    }
  }

  return count;
}

/**
 * Generic pattern-based detection for crypto, 529, etc.
 */
async function detectByPattern(txns, patterns, transferType) {
  let count = 0;

  for (const tx of txns) {
    if (tx._matched) continue;
    const combined = ((tx.name || '') + ' ' + (tx.merchant_name || '')).toLowerCase();

    const matched = patterns.some(p => combined.includes(p));
    if (matched && await markTransfer(tx.id, transferType, null)) {
      tx._matched = true;
      count++;
    }
  }

  return count;
}

// Candidates were read without locks, so a category edit may have committed
// since. Lock the rows (a pair lowest ID first) and check them again before
// flagging.
async function markTransfer(txId, transferType, pairId) {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
    const { rowCount } = await client.query(`
      UPDATE transactions t
      SET is_transfer = true, transfer_type = $1, transfer_pair_id = $2, updated_at = now()
      WHERE t.id = $3 AND ${DETECTABLE} AND ${UNSPLIT}
    `, [transferType, pairId, txId]);
    return rowCount === 1;
  });
}

async function markTransferPair(firstId, secondId) {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT id FROM transactions WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
      [firstId, secondId]
    );
    const { rows } = await client.query(
      `SELECT t.id FROM transactions t WHERE t.id IN ($1, $2) AND ${DETECTABLE} AND ${UNSPLIT}`,
      [firstId, secondId]
    );
    if (rows.length !== 2) return false;
    const { rowCount } = await client.query(`
      UPDATE transactions t
      SET is_transfer = true,
          transfer_type = 'inter_account',
          transfer_pair_id = CASE WHEN t.id = $1 THEN $2 ELSE $1 END,
          updated_at = now()
      WHERE t.id IN ($1, $2)
    `, [firstId, secondId]);
    return rowCount === 2;
  });
}

module.exports = { detectTransfers, CC_PAYMENT_PATTERNS, CRYPTO_PATTERNS, COLLEGE_529_PATTERNS, isCashAccount };
