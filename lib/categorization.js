'use strict';

const { pool } = require('./db');
const logger = require('./logger');
const { suggestCategoryNameFromPlaid } = require('./plaid-category-mapper');

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
    if (merchant === pattern || (!merchant && name === pattern)) {
      return rule.category_id;
    }
  }

  // Second pass: contains matches
  for (const rule of rules) {
    if (rule.match_type === 'exact') continue;
    const pattern = rule.merchant_pattern.toLowerCase();
    const target = merchant || name;
    if (target.includes(pattern)) {
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

  const { rows: categoryRows } = await pool.query(
    'SELECT id, name FROM categories'
  );
  const categoryIdByName = new Map(categoryRows.map(c => [c.name, c.id]));

  const { rows: uncategorized } = await pool.query(
    `SELECT id, merchant_name, name, plaid_category
     FROM transactions
     WHERE category_id IS NULL AND is_transfer = false AND is_hidden = false`
  );
  if (rules.length === 0 && uncategorized.length === 0) return { matched: 0, total: 0 };

  let matched = 0;
  for (const tx of uncategorized) {
    let categoryId = categorizeTransaction(tx, rules);
    if (!categoryId) {
      const suggestedName = suggestCategoryNameFromPlaid(tx.plaid_category);
      categoryId = suggestedName ? categoryIdByName.get(suggestedName) || null : null;
    }
    if (categoryId) {
      await pool.query(
        'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = $2',
        [categoryId, tx.id]
      );
      matched++;
    }
  }

  logger.info('Auto-categorization complete', { matched, total: uncategorized.length });
  return { matched, total: uncategorized.length };
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
    'SELECT id, merchant_name, name FROM transactions WHERE is_transfer = false AND is_hidden = false'
  );

  let matched = 0;
  for (const tx of txns) {
    const categoryId = categorizeTransaction(tx, rules);
    if (categoryId) {
      await pool.query(
        'UPDATE transactions SET category_id = $1, updated_at = now() WHERE id = $2',
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
