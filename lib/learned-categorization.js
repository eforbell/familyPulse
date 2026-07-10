'use strict';

const logger = require('./logger');
const { buildMerchantFingerprint } = require('./merchant-normalizer');
const { suggestCategoryNameFromPlaid } = require('./plaid-category-mapper');

const UNKNOWN_FINGERPRINT = 'unknown';
const HISTORY_AUTO_MIN = 3;
const HISTORY_SUGGEST_MIN = 3;
const HISTORY_SUGGEST_RATIO = 0.6;

function fingerprintForTransaction(tx) {
  return buildMerchantFingerprint(tx);
}

async function categoryAllowsLearning(client, categoryId) {
  if (!categoryId) return false;
  const { rows } = await client.query(
    'SELECT COALESCE(exclude_from_learning, false) AS exclude_from_learning FROM categories WHERE id = $1',
    [categoryId]
  );
  return !!rows[0] && !rows[0].exclude_from_learning;
}

async function captureManualLearning(client, tx, categoryId) {
  let savepointStarted = false;
  try {
    await client.query('SAVEPOINT manual_learning');
    savepointStarted = true;

    const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
    if (!fingerprint || fingerprint === UNKNOWN_FINGERPRINT) {
      await client.query('RELEASE SAVEPOINT manual_learning');
      return { learned: false, reason: 'unknown_fingerprint' };
    }
    if (!(await categoryAllowsLearning(client, categoryId))) {
      await client.query('RELEASE SAVEPOINT manual_learning');
      return { learned: false, reason: 'category_excluded' };
    }

    await client.query(
      `INSERT INTO learned_category_rules (merchant_fingerprint, category_id, occurrence_count, last_seen_at, updated_at)
       VALUES ($1, $2, 1, now(), now())
       ON CONFLICT (merchant_fingerprint) DO UPDATE SET
         category_id = EXCLUDED.category_id,
         occurrence_count = learned_category_rules.occurrence_count + 1,
         last_seen_at = now(),
         updated_at = now()`,
      [fingerprint, categoryId]
    );
    await client.query('RELEASE SAVEPOINT manual_learning');
    return { learned: true, fingerprint };
  } catch (err) {
    if (savepointStarted) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT manual_learning');
        await client.query('RELEASE SAVEPOINT manual_learning');
      } catch (rollbackErr) {
        logger.warn('Manual categorization learning rollback failed', {
          transactionId: tx?.id,
          error: rollbackErr.message
        });
      }
    }
    logger.warn('Manual categorization learning failed', { transactionId: tx?.id, error: err.message });
    return { learned: false, reason: 'error' };
  }
}

async function captureManualLearningForTransactionIds(client, transactionIds, categoryId) {
  const { rows } = await client.query(
    `SELECT id, merchant_name, name, merchant_fingerprint
     FROM transactions
     WHERE id = ANY($1::int[])`,
    [transactionIds]
  );
  const results = [];
  for (const tx of rows) {
    const fingerprint = tx.merchant_fingerprint || fingerprintForTransaction(tx);
    if (fingerprint && fingerprint !== tx.merchant_fingerprint) {
      await client.query('UPDATE transactions SET merchant_fingerprint = $1 WHERE id = $2', [fingerprint, tx.id]);
      tx.merchant_fingerprint = fingerprint;
    }
    results.push(await captureManualLearning(client, tx, categoryId));
  }
  return results;
}

function chooseHistorySuggestion(history) {
  if (!history || history.total < HISTORY_SUGGEST_MIN) return null;
  const top = history.counts[0];
  if (!top) return null;
  if (top.count === history.total) return null;
  return top.count / history.total >= HISTORY_SUGGEST_RATIO ? top.category_id : null;
}

async function loadLearningSignals(client, transactions) {
  const fingerprints = [...new Set(transactions.map(tx => tx.merchant_fingerprint).filter(fp => fp && fp !== UNKNOWN_FINGERPRINT))];
  if (fingerprints.length === 0) {
    return { learnedRules: new Map(), histories: new Map(), rejections: new Set(), plaidCategoryIdsByName: new Map() };
  }

  const [rulesResult, historyResult, rejectionResult, categoryResult] = await Promise.all([
    client.query(
      `SELECT lcr.merchant_fingerprint, lcr.category_id
       FROM learned_category_rules lcr
       JOIN categories c ON c.id = lcr.category_id
       WHERE lcr.merchant_fingerprint = ANY($1::text[])
         AND COALESCE(c.exclude_from_learning, false) = false`,
      [fingerprints]
    ),
    client.query(
      `SELECT t.merchant_fingerprint, t.category_id, count(*)::int AS count
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.merchant_fingerprint = ANY($1::text[])
         AND t.category_id IS NOT NULL
         AND COALESCE(c.exclude_from_learning, false) = false
         AND t.is_hidden = false
       GROUP BY t.merchant_fingerprint, t.category_id`,
      [fingerprints]
    ),
    client.query(
      `SELECT merchant_fingerprint, category_id
       FROM suggestion_rejections
       WHERE merchant_fingerprint = ANY($1::text[])`,
      [fingerprints]
    ),
    client.query(
      `SELECT id, name
       FROM categories
       WHERE COALESCE(exclude_from_learning, false) = false`
    )
  ]);

  const learnedRules = new Map(rulesResult.rows.map(row => [row.merchant_fingerprint, row.category_id]));
  const histories = new Map();
  for (const row of historyResult.rows) {
    if (!histories.has(row.merchant_fingerprint)) histories.set(row.merchant_fingerprint, { total: 0, counts: [] });
    const history = histories.get(row.merchant_fingerprint);
    history.total += row.count;
    history.counts.push({ category_id: row.category_id, count: row.count });
  }
  for (const history of histories.values()) history.counts.sort((a, b) => b.count - a.count);

  const rejections = new Set(rejectionResult.rows.map(row => `${row.merchant_fingerprint}:${row.category_id}`));
  const plaidCategoryIdsByName = new Map(categoryResult.rows.map(row => [row.name, row.id]));
  return { learnedRules, histories, rejections, plaidCategoryIdsByName };
}

function rejectionKey(fingerprint, categoryId) {
  return `${fingerprint}:${categoryId}`;
}

function decideLearnedCategory(tx, signals) {
  const fingerprint = tx.merchant_fingerprint;
  if (!fingerprint || fingerprint === UNKNOWN_FINGERPRINT) return { action: 'none' };

  const learnedCategoryId = signals.learnedRules.get(fingerprint);
  if (learnedCategoryId) return { action: 'apply', categoryId: learnedCategoryId, source: 'learned' };

  const history = signals.histories.get(fingerprint);
  if (history?.total >= HISTORY_AUTO_MIN && history.counts.length === 1) {
    return { action: 'apply', categoryId: history.counts[0].category_id, source: 'learned' };
  }

  const historySuggestion = chooseHistorySuggestion(history);
  if (historySuggestion && !signals.rejections.has(rejectionKey(fingerprint, historySuggestion))) {
    return { action: 'suggest', categoryId: historySuggestion, source: 'history' };
  }

  const plaidName = suggestCategoryNameFromPlaid(tx.plaid_category);
  const plaidCategoryId = plaidName ? signals.plaidCategoryIdsByName.get(plaidName) : null;
  if (plaidCategoryId && !signals.rejections.has(rejectionKey(fingerprint, plaidCategoryId))) {
    return { action: 'suggest', categoryId: plaidCategoryId, source: 'plaid' };
  }

  return { action: 'none' };
}

async function rejectSuggestion(client, { transactionId, fingerprint, categoryId, memberId }) {
  await client.query(
    `INSERT INTO suggestion_rejections (merchant_fingerprint, category_id, transaction_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_fingerprint, category_id) DO NOTHING`,
    [fingerprint, categoryId, transactionId || null, memberId || null]
  );
  await client.query(
    `UPDATE transactions
     SET suggested_category_id = NULL,
         suggestion_source = NULL,
         updated_at = now()
     WHERE category_id IS NULL
       AND suggested_category_id = $2
       AND (merchant_fingerprint = $1 OR id = $3)`,
    [fingerprint, categoryId, transactionId || null]
  );
}

module.exports = {
  UNKNOWN_FINGERPRINT,
  fingerprintForTransaction,
  captureManualLearning,
  captureManualLearningForTransactionIds,
  loadLearningSignals,
  decideLearnedCategory,
  rejectSuggestion
};
