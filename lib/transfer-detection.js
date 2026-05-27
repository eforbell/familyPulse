'use strict';

const { pool } = require('./db');
const logger = require('./logger');

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
  const { rows: txns } = await pool.query(`
    SELECT t.id, t.amount, t.date, t.merchant_name, t.name, t.account_id, t.pending,
           a.type AS account_type, a.plaid_account_id
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.date >= $1 AND t.is_transfer = false AND t.pending = false AND t.is_hidden = false
    ORDER BY t.date DESC
  `, [cutoffStr]);

  // 1. Inter-account transfers
  results.inter_account = await detectInterAccount(txns);

  // 2. CC payments
  results.cc_payment = await detectCCPayments(txns);

  // 3. Crypto/BTC
  results.crypto = await detectByPattern(txns, CRYPTO_PATTERNS, 'crypto_savings');

  // 4. 529 contributions
  results.college_529 = await detectByPattern(txns, COLLEGE_529_PATTERNS, '529_contribution');

  // Also check DB-stored category_rules for additional patterns
  await detectFromCategoryRules(txns, results);

  results.total = results.inter_account + results.cc_payment + results.crypto + results.college_529;
  logger.info('Transfer detection complete', results);
  return results;
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
      await markTransfer(a.id, 'inter_account', b.id);
      await markTransfer(b.id, 'inter_account', a.id);
      a._matched = true;
      b._matched = true;
      count += 2;
      break;
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
    if (isCC) {
      await markTransfer(tx.id, 'cc_payment', null);
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
    if (matched) {
      await markTransfer(tx.id, transferType, null);
      tx._matched = true;
      count++;
    }
  }

  return count;
}

/**
 * Check category_rules table for additional transfer patterns
 */
async function detectFromCategoryRules(txns, results) {
  const { rows: rules } = await pool.query(`
    SELECT cr.merchant_pattern, cr.match_type, c.name AS category_name, c.is_transfer_class
    FROM category_rules cr
    JOIN categories c ON cr.category_id = c.id
    WHERE c.is_transfer_class = true
  `);

  for (const tx of txns) {
    if (tx._matched) continue;
    const combined = ((tx.name || '') + ' ' + (tx.merchant_name || '')).toLowerCase();

    for (const rule of rules) {
      const pattern = rule.merchant_pattern.toLowerCase();
      let matched = false;

      if (rule.match_type === 'contains') {
        matched = combined.includes(pattern);
      } else if (rule.match_type === 'exact') {
        matched = combined === pattern;
      } else if (rule.match_type === 'starts_with') {
        matched = combined.startsWith(pattern);
      }

      if (matched) {
        const type = rule.category_name.toLowerCase().includes('529') ? '529_contribution'
          : rule.category_name.toLowerCase().includes('crypto') ? 'crypto_savings'
          : 'categorized_transfer';
        await markTransfer(tx.id, type, null);
        tx._matched = true;
        results.total = (results.total || 0) + 1;
        break;
      }
    }
  }
}

async function markTransfer(txId, transferType, pairId) {
  await pool.query(`
    UPDATE transactions
    SET is_transfer = true, transfer_type = $1, transfer_pair_id = $2, updated_at = now()
    WHERE id = $3 AND is_transfer = false
  `, [transferType, pairId, txId]);
}

module.exports = { detectTransfers, CC_PAYMENT_PATTERNS, CRYPTO_PATTERNS, COLLEGE_529_PATTERNS, isCashAccount };
