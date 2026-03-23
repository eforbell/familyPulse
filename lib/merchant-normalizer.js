'use strict';

const CORPORATE_SUFFIX_RE = /\b(llc|inc|co|corp|corporation|ltd)\b/g;
const DATE_TOKEN_RE = /\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|\d{4})\b/g;
const TRAILING_ID_RE = /(?:[\s#/.-]*\d){6,}\s*$/;
const NON_WORD_RE = /[^a-z0-9]+/g;

function normalizeMerchantName(merchantName, fallbackName = '') {
  const raw = typeof merchantName === 'string' && merchantName.trim()
    ? merchantName
    : (typeof fallbackName === 'string' ? fallbackName : '');

  const lowered = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(DATE_TOKEN_RE, ' ')
    .replace(CORPORATE_SUFFIX_RE, ' ')
    .replace(TRAILING_ID_RE, ' ')
    .replace(NON_WORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return lowered || 'unknown';
}

function buildMerchantFingerprint(tx) {
  return normalizeMerchantName(tx?.merchant_name, tx?.name);
}

module.exports = {
  normalizeMerchantName,
  buildMerchantFingerprint
};
