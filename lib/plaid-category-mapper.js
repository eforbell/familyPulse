'use strict';

function parsePlaidCategory(plaidCategory) {
  if (!plaidCategory) return null;
  if (typeof plaidCategory === 'object') return plaidCategory;
  try {
    return JSON.parse(plaidCategory);
  } catch {
    return null;
  }
}

function suggestCategoryNameFromPlaid(plaidCategory) {
  const category = parsePlaidCategory(plaidCategory);
  if (!category) return null;

  const detailed = (category.detailed || '').toUpperCase();
  const primary = (category.primary || '').toUpperCase();

  if (detailed === 'FOOD_AND_DRINK_GROCERIES') return 'Groceries';
  if (detailed === 'FOOD_AND_DRINK_RESTAURANT') return 'Dining Out';
  if (detailed === 'TRANSPORTATION_GAS') return 'Gas & Auto';
  if (detailed.startsWith('RENT_AND_UTILITIES')) return 'Utilities';
  if (detailed.startsWith('MEDICAL')) return 'Healthcare';
  if (detailed.startsWith('ENTERTAINMENT')) return 'Entertainment';
  if (detailed.startsWith('GENERAL_MERCHANDISE')) return 'Shopping';
  if (detailed.startsWith('HOME_IMPROVEMENT')) return 'Home & Garden';
  if (detailed.startsWith('TRAVEL')) return 'Travel';
  if (detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'CC Payment';

  if (primary === 'INCOME') return 'Income';
  if (primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT') return 'Transfer';
  if (primary === 'LOAN_PAYMENTS') return 'CC Payment';
  if (primary === 'GENERAL_MERCHANDISE') return 'Shopping';
  if (primary === 'HOME_IMPROVEMENT') return 'Home & Garden';
  if (primary === 'FOOD_AND_DRINK') return 'Dining Out';
  if (primary === 'TRANSPORTATION') return 'Gas & Auto';
  if (primary === 'RENT_AND_UTILITIES') return 'Utilities';
  if (primary === 'MEDICAL') return 'Healthcare';
  if (primary === 'TRAVEL') return 'Travel';
  if (primary === 'ENTERTAINMENT') return 'Entertainment';

  return null;
}

module.exports = { parsePlaidCategory, suggestCategoryNameFromPlaid };
