'use strict';

const { pool } = require('./db');

const CHECK_LIKE_PATTERN = /^\s*check(?:\s*#)?\s*\d+\s*$/i;

function getRawSourceText(tx) {
  return tx?.merchant_name || tx?.name || '';
}

function computeEffectiveDisplayName(tx) {
  return tx?.display_name_override || getRawSourceText(tx);
}

function isCheckLikeRawSourceText(text) {
  return CHECK_LIKE_PATTERN.test(String(text || ''));
}

async function getEnabledRenameRuleForRawSource(client, rawSourceText, options = {}) {
  const sourceText = String(rawSourceText || '').trim();
  if (!sourceText) return null;

  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, raw_source_text, display_name, match_type, enabled, created_by,
            last_matched_at, created_at, updated_at
     FROM merchant_rename_rules
     WHERE enabled = true
       AND match_type = 'exact'
       AND raw_source_text = $1
     LIMIT 1`,
    [sourceText]
  );

  const rule = rows[0] || null;
  if (!rule || !options.touchLastMatchedAt) return rule;

  const { rows: touched } = await db.query(
    `UPDATE merchant_rename_rules
     SET last_matched_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING id, raw_source_text, display_name, match_type, enabled, created_by,
               last_matched_at, created_at, updated_at`,
    [rule.id]
  );

  return touched[0] || rule;
}

async function upsertMerchantRenameRule(client, { rawSourceText, displayName, createdBy }) {
  const sourceText = String(rawSourceText || '').trim();
  const cleanDisplayName = String(displayName || '').trim();
  if (!sourceText) {
    throw Object.assign(new Error('Transaction has no raw synced source text to bind a future rename rule'), { status: 400 });
  }
  if (!cleanDisplayName) {
    throw Object.assign(new Error('Display name is required to create a future rename rule'), { status: 400 });
  }

  const db = client || pool;
  const { rows } = await db.query(
    `INSERT INTO merchant_rename_rules (raw_source_text, display_name, match_type, enabled, created_by, last_matched_at)
     VALUES ($1, $2, 'exact', true, $3, now())
     ON CONFLICT (raw_source_text) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       match_type = 'exact',
       enabled = true,
       created_by = EXCLUDED.created_by,
       updated_at = now()
     RETURNING id, raw_source_text, display_name, match_type, enabled, created_by,
               last_matched_at, created_at, updated_at`,
    [sourceText, cleanDisplayName, createdBy || null]
  );

  return rows[0] || null;
}

module.exports = {
  getRawSourceText,
  computeEffectiveDisplayName,
  isCheckLikeRawSourceText,
  getEnabledRenameRuleForRawSource,
  upsertMerchantRenameRule
};
