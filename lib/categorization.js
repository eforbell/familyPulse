'use strict';

const { pool } = require('./db');
const logger = require('./logger');
const {
  fingerprintForTransaction,
  loadLearningSignals,
  decideLearnedCategory
} = require('./learned-categorization');

/**
 * Pure function: match a transaction against rules.
 * Priority: exact match > contains match.
 * Checks merchant_name first, falls back to name.
 * Returns category_id or null.
 */
function categorizeTransaction(tx, rules) {
  const merchant = (tx.merchant_name || '').toLowerCase();
  const name = (tx.name || '').toLowerCase();

  // First pass: exact matches
  for (const rule of rules) {
    if (rule.match_type !== 'exact') continue;
    const pattern = rule.merchant_pattern.toLowerCase();
    if (merchant === pattern || name === pattern) {
      return rule.category_id;
    }
  }

  // Second pass: contains matches
  for (const rule of rules) {
    if (rule.match_type === 'exact') continue;
    const pattern = rule.merchant_pattern.toLowerCase();
    if (merchant.includes(pattern) || name.includes(pattern)) {
      return rule.category_id;
    }
  }

  return null;
}

/**
 * Apply rules to all uncategorized, non-transfer transactions.
 * Returns { matched, total }.
 */
async function categorizeMany() {
  const { rows: rules } = await pool.query(
    'SELECT id, merchant_pattern, category_id, match_type FROM category_rules ORDER BY match_type, id'
  );

  const { rows: uncategorized } = await pool.query(
    `SELECT id, merchant_name, name, plaid_category, merchant_fingerprint, categorization_source
     FROM transactions
     WHERE category_id IS NULL
       AND is_transfer = false
       AND is_hidden = false
       AND COALESCE(categorization_source, '') <> 'manual'`
  );
  if (rules.length === 0 && uncategorized.length === 0) return { matched: 0, total: 0 };

  for (const tx of uncategorized) {
    const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
    if (fingerprint !== tx.merchant_fingerprint) {
      tx.merchant_fingerprint = fingerprint;
      await pool.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, tx.id]);
    }
  }
  const signals = await loadLearningSignals(pool, uncategorized);

  let matched = 0;
  let ruleMatched = 0;
  let learnedMatched = 0;
  let suggested = 0;
  for (const tx of uncategorized) {
    let categoryId = categorizeTransaction(tx, rules);
    if (categoryId) {
      await pool.query(
        `UPDATE transactions
         SET category_id = $1,
             categorization_source = 'rule',
             suggested_category_id = NULL,
             suggestion_source = NULL,
             updated_at = now()
         WHERE id = $2`,
        [categoryId, tx.id]
      );
      matched++;
      ruleMatched++;
      continue;
    }

    const decision = decideLearnedCategory(tx, signals);
    if (decision.action === 'apply') {
      await pool.query(
        `UPDATE transactions
         SET category_id = $1,
             categorization_source = 'learned',
             suggested_category_id = NULL,
             suggestion_source = NULL,
             updated_at = now()
         WHERE id = $2`,
        [decision.categoryId, tx.id]
      );
      await pool.query(
        'UPDATE learned_category_rules SET last_applied_at = now(), updated_at = now() WHERE merchant_fingerprint = $1',
        [tx.merchant_fingerprint]
      );
      matched++;
      learnedMatched++;
    } else if (decision.action === 'suggest') {
      await pool.query(
        `UPDATE transactions
         SET suggested_category_id = $1,
             suggestion_source = $2,
             updated_at = now()
         WHERE id = $3`,
        [decision.categoryId, decision.source, tx.id]
      );
      suggested++;
    }
  }

  const result = {
    matched,
    total: uncategorized.length,
    rules: ruleMatched,
    learned: learnedMatched,
    plaid: 0,
    suggested
  };
  logger.info('Auto-categorization complete', result);
  return result;
}

/**
 * Re-apply rules to ALL non-transfer transactions (overwriting existing categories).
 */
async function applyRulesRetroactive() {
  const { rows: rules } = await pool.query(
    'SELECT id, merchant_pattern, category_id, match_type FROM category_rules ORDER BY match_type, id'
  );
  if (rules.length === 0) return { matched: 0, total: 0 };

  const { rows: txns } = await pool.query(
    `SELECT id, merchant_name, name
     FROM transactions
     WHERE is_transfer = false
       AND is_hidden = false
       AND COALESCE(categorization_source, '') <> 'manual'`
  );

  let matched = 0;
  for (const tx of txns) {
    const categoryId = categorizeTransaction(tx, rules);
    if (categoryId) {
      await pool.query(
        `UPDATE transactions
         SET category_id = $1,
             categorization_source = 'rule',
             suggested_category_id = NULL,
             suggestion_source = NULL,
             updated_at = now()
         WHERE id = $2`,
        [categoryId, tx.id]
      );
      matched++;
    }
  }

  logger.info('Retroactive categorization complete', { matched, total: txns.length });
  return { matched, total: txns.length };
}

/**
 * Preview which transactions would match a pattern (no modifications).
 */
async function previewRule(pattern, matchType = 'contains') {
  const lowerPattern = pattern.toLowerCase();

  const { rows } = await pool.query(`
    SELECT t.id, t.merchant_name, t.name, t.amount, t.date, a.name AS account_name
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.is_transfer = false
      AND t.is_hidden = false
    ORDER BY t.date DESC
    LIMIT 500
  `);

  return rows.filter(tx => {
    const target = (tx.merchant_name || tx.name || '').toLowerCase();
    if (matchType === 'exact') return target === lowerPattern;
    return target.includes(lowerPattern);
  });
}

module.exports = { categorizeTransaction, categorizeMany, applyRulesRetroactive, previewRule };
