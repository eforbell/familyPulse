'use strict';

const LIABILITY_ACCESS_STATUS = Object.freeze({
  ENABLED: 'enabled',
  MISSING: 'missing',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown'
});

function hasLiabilityAccounts(accounts = []) {
  return accounts.some((account) => account.type === 'credit' || account.type === 'loan');
}

function extractItemProducts(itemInfo) {
  const item = itemInfo?.item || itemInfo || {};
  return {
    consentedProducts: Array.isArray(item.consented_products) ? item.consented_products : [],
    products: Array.isArray(item.products) ? item.products : [],
    availableProducts: Array.isArray(item.available_products) ? item.available_products : []
  };
}

function hasLiabilityConsent(itemInfo) {
  const { consentedProducts, products } = extractItemProducts(itemInfo);
  return consentedProducts.includes('liabilities') || products.includes('liabilities');
}

function deriveLiabilityAccessStatus({
  itemInfo,
  accounts = [],
  liabilityErrorCode = null,
  hasLiabilityData = false,
  currentStatus = LIABILITY_ACCESS_STATUS.UNKNOWN
}) {
  const { availableProducts } = extractItemProducts(itemInfo);

  if (hasLiabilityConsent(itemInfo)) {
    return LIABILITY_ACCESS_STATUS.ENABLED;
  }

  if (hasLiabilityData) {
    return LIABILITY_ACCESS_STATUS.ENABLED;
  }

  if (liabilityErrorCode === 'ADDITIONAL_CONSENT_REQUIRED') {
    return LIABILITY_ACCESS_STATUS.MISSING;
  }

  if (liabilityErrorCode === 'PRODUCTS_NOT_SUPPORTED' || liabilityErrorCode === 'INVALID_PRODUCT') {
    return LIABILITY_ACCESS_STATUS.UNSUPPORTED;
  }

  if (liabilityErrorCode === 'NO_LIABILITY_ACCOUNTS' || liabilityErrorCode === 'PRODUCT_NOT_READY') {
    return LIABILITY_ACCESS_STATUS.ENABLED;
  }

  if (availableProducts.length > 0 && !availableProducts.includes('liabilities')) {
    return LIABILITY_ACCESS_STATUS.UNSUPPORTED;
  }

  if (hasLiabilityAccounts(accounts)) {
    return LIABILITY_ACCESS_STATUS.MISSING;
  }

  if (currentStatus === LIABILITY_ACCESS_STATUS.ENABLED || currentStatus === LIABILITY_ACCESS_STATUS.UNSUPPORTED) {
    return currentStatus;
  }

  return LIABILITY_ACCESS_STATUS.UNKNOWN;
}

module.exports = {
  LIABILITY_ACCESS_STATUS,
  deriveLiabilityAccessStatus,
  hasLiabilityAccounts,
  hasLiabilityConsent
};
