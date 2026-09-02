'use strict';

const crypto = require('node:crypto');
const { pool, withTransaction } = require('./db');
const { replaceTransactionAllocations } = require('./transaction-allocations');

const DUPLICATE_REASON = 'duplicate_prefer_plaid';

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(t => t.length >= 2);
}

function jaccardSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

function dayDiff(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function amountToCents(value) {
  return Math.round(parseFloat(value) * 100);
}

function nameScore(importTx, plaidTx) {
  const importName = normalizeText(importTx.description);
  const plaidName = normalizeText(plaidTx.description);

  if (!importName && !plaidName) return 0.2;
  if (importName && plaidName && importName === plaidName) return 1;
  if (importName && plaidName && (importName.includes(plaidName) || plaidName.includes(importName))) {
    return 0.85;
  }
  return jaccardSimilarity(tokenize(importName), tokenize(plaidName));
}

function accountScore(importTx, plaidTx) {
  if (importTx.account_id === plaidTx.account_id) return 1;

  const importMask = importTx.account_mask || '';
  const plaidMask = plaidTx.account_mask || '';
  if (importMask && plaidMask && importMask === plaidMask) return 0.8;

  const importAcct = normalizeText(importTx.account_name);
  const plaidAcct = normalizeText(plaidTx.account_name);
  if (importAcct && plaidAcct && importAcct === plaidAcct) return 0.7;

  return 0;
}

function dateScore(daysApart) {
  if (daysApart === 0) return 1;
  if (daysApart === 1) return 0.7;
  if (daysApart === 2) return 0.4;
  return 0;
}

function isAcceptedMatch(candidate) {
  if (candidate.accountScore >= 1 && candidate.nameScore >= 0.55 && candidate.daysApart <= 2) return true;
  if (candidate.accountScore >= 0.7 && candidate.nameScore >= 0.9 && candidate.daysApart <= 1) return true;
  return false;
}

function computeCandidate(importTx, plaidTx) {
  const centsA = amountToCents(importTx.amount);
  const centsB = amountToCents(plaidTx.amount);
  if (centsA !== centsB) return null;

  if (Math.sign(parseFloat(importTx.amount)) !== Math.sign(parseFloat(plaidTx.amount))) return null;

  const daysApart = dayDiff(importTx.date, plaidTx.date);
  if (daysApart > 2) return null;

  const nScore = nameScore(importTx, plaidTx);
  const aScore = accountScore(importTx, plaidTx);
  const dScore = dateScore(daysApart);
  const score = (aScore * 0.5) + (nScore * 0.35) + (dScore * 0.15);

  return {
    importTxId: importTx.id,
    plaidTxId: plaidTx.id,
    score: Number(score.toFixed(4)),
    daysApart,
    nameScore: Number(nScore.toFixed(4)),
    accountScore: Number(aScore.toFixed(4))
  };
}

async function fetchTransactions({ dateFrom = null, dateTo = null } = {}) {
  const conditions = ['t.is_hidden = false'];
  const params = [];
  let idx = 1;

  if (dateFrom) {
    conditions.push(`t.date >= $${idx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`t.date <= $${idx++}`);
    params.push(dateTo);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT t.id, t.account_id, t.amount::numeric, t.date, t.source,
           COALESCE(t.merchant_name, t.name, '') AS description,
           a.name AS account_name, a.mask AS account_mask
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    ${where}
    ORDER BY t.id
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

function matchDuplicates(rows) {
  const plaid = rows.filter(r => r.source === 'plaid');
  const imported = rows.filter(r => r.source !== 'plaid');

  const plaidByAmount = new Map();
  for (const tx of plaid) {
    const key = amountToCents(tx.amount);
    if (!plaidByAmount.has(key)) plaidByAmount.set(key, []);
    plaidByAmount.get(key).push(tx);
  }

  const matches = [];
  const ambiguous = [];
  const claimedPlaidIds = new Set();

  for (const importTx of imported) {
    const candidates = plaidByAmount.get(amountToCents(importTx.amount)) || [];
    if (candidates.length === 0) continue;

    const scored = [];
    for (const plaidTx of candidates) {
      if (claimedPlaidIds.has(plaidTx.id)) continue;
      const candidate = computeCandidate(importTx, plaidTx);
      if (!candidate) continue;
      if (!isAcceptedMatch(candidate)) continue;
      scored.push(candidate);
    }
    if (scored.length === 0) continue;

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];

    if (second && Math.abs(best.score - second.score) < 0.08) {
      ambiguous.push({
        import_tx_id: importTx.id,
        plaid_tx_ids: [best.plaidTxId, second.plaidTxId],
        best_score: best.score
      });
      continue;
    }

    matches.push({
      import_tx_id: importTx.id,
      plaid_tx_id: best.plaidTxId,
      score: best.score,
      days_apart: best.daysApart
    });
    claimedPlaidIds.add(best.plaidTxId);
  }

  return { matches, ambiguous, importedCount: imported.length };
}

async function previewDuplicateImports(options = {}) {
  const rows = await fetchTransactions(options);
  const { matches, ambiguous, importedCount } = matchDuplicates(rows);

  const sample = matches.slice(0, 25);
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ options, matches: sample, ambiguous: ambiguous.slice(0, 25) }))
    .digest('hex')
    .slice(0, 24);

  return {
    strategy: 'prefer_plaid',
    imported_candidates: importedCount,
    duplicates_found: matches.length,
    ambiguous_count: ambiguous.length,
    fingerprint,
    matches_sample: sample,
    ambiguous_sample: ambiguous.slice(0, 25),
    matches
  };
}

async function applyDuplicateHide({ dateFrom = null, dateTo = null, actor = null } = {}) {
  const preview = await previewDuplicateImports({ dateFrom, dateTo });

  if (preview.matches.length === 0) {
    return {
      run_id: null,
      strategy: 'prefer_plaid',
      hidden: 0,
      category_copied: 0,
      ambiguous_count: preview.ambiguous_count
    };
  }

  return withTransaction(async (client) => {
    const { rows: [run] } = await client.query(
      `INSERT INTO dedup_runs (status, strategy, txns_hidden, ambiguous_count, details, created_by)
       VALUES ('complete', 'prefer_plaid', 0, $1, $2, $3)
       RETURNING id`,
      [
        preview.ambiguous_count,
        JSON.stringify({
          dateFrom, dateTo,
          fingerprint: preview.fingerprint,
          duplicates_found: preview.duplicates_found,
          imported_candidates: preview.imported_candidates
        }),
        actor
      ]
    );

    let hidden = 0;
    let categoryCopied = 0;

    for (const match of preview.matches) {
      // Serialize dedup with sync and manual categorization. Lock both rows in
      // ID order so eligibility is evaluated against a stable source and target.
      await client.query(
        `SELECT id FROM transactions
         WHERE id = ANY($1::int[])
         ORDER BY id
         FOR UPDATE`,
        [[match.import_tx_id, match.plaid_tx_id]]
      );

      const { rows: importedAllocations } = await client.query(
        `SELECT ta.category_id, ta.amount, ta.position, c.name AS category_name
         FROM transaction_allocations ta
         LEFT JOIN categories c ON c.id = ta.category_id
         WHERE ta.transaction_id = $1
         ORDER BY ta.position`,
        [match.import_tx_id]
      );
      const importedHasMeaningfulCategory = importedAllocations.some(allocation => (
        allocation.category_id !== null && allocation.category_name !== 'Uncategorized'
      ));
      const { rows: [plaidCategoryState] } = await client.query(
        `SELECT t.pending, t.is_transfer, EXISTS (
           SELECT 1 FROM transaction_allocations ta
           LEFT JOIN categories c ON c.id = ta.category_id
           WHERE ta.transaction_id = $1
             AND ta.category_id IS NOT NULL
             AND c.name <> 'Uncategorized'
         ) AS categorized
         FROM transactions t
         WHERE t.id = $1`,
        [match.plaid_tx_id]
      );

      // Keep the imported row visible until a pending target posts; otherwise
      // hiding it here would discard split detail with no later copy opportunity.
      if (importedAllocations.length > 1 && (plaidCategoryState.pending || plaidCategoryState.is_transfer)) continue;

      const canCopyAllocations = !plaidCategoryState.is_transfer || importedAllocations.length === 1;
      const { rowCount } = await client.query(
        `UPDATE transactions
         SET is_hidden = true,
             hidden_reason = $1,
             duplicate_of_transaction_id = $2,
             dedup_run_id = $3,
             updated_at = now()
         WHERE id = $4
           AND source <> 'plaid'
           AND is_hidden = false`,
        [DUPLICATE_REASON, match.plaid_tx_id, run.id, match.import_tx_id]
      );

      if (rowCount === 0) continue;
      hidden++;

      if (!plaidCategoryState.categorized && importedHasMeaningfulCategory && canCopyAllocations) {
        await replaceTransactionAllocations(client, {
          transactionId: match.plaid_tx_id,
          allocations: importedAllocations,
          memberId: null,
          categorizationSource: 'manual'
        });
        categoryCopied++;
      }
    }

    await client.query(
      `UPDATE dedup_runs
       SET txns_hidden = $1, category_copied = $2
       WHERE id = $3`,
      [hidden, categoryCopied, run.id]
    );

    return {
      run_id: run.id,
      strategy: 'prefer_plaid',
      hidden,
      category_copied: categoryCopied,
      ambiguous_count: preview.ambiguous_count
    };
  });
}

module.exports = {
  DUPLICATE_REASON,
  normalizeText,
  previewDuplicateImports,
  applyDuplicateHide
};
