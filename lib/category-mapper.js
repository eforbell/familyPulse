'use strict';

/**
 * Known mappings from Monarch Money category names → Family Pulse category names.
 * Built from inspecting the actual Monarch export against seed categories.
 */
const KNOWN_MAPPINGS = {
  'groceries':                'Groceries',
  'shopping':                 'Shopping',
  'restaurants & bars':       'Dining Out',
  'fast food':                'Dining Out',
  'coffee shops':             'Dining Out',
  'gas':                      'Gas & Auto',
  'auto maintenance':         'Gas & Auto',
  'auto payment':             'Gas & Auto',
  'car insurance':            'Insurance',
  'parking & tolls':          'Gas & Auto',
  'gas & electric':           'Utilities',
  'phone':                    'Utilities',
  'home improvement':         'Home & Garden',
  'furniture & housewares':   'Home & Garden',
  'cleaners':                 'Home & Garden',
  'medical':                  'Healthcare',
  'salon/haircare':           'Healthcare',
  'entertainment & recreation': 'Entertainment',
  'streaming service':        'Subscriptions',
  'subscriptions':            'Subscriptions',
  'adobe lightroom':          'Subscriptions',
  'software service':         'Subscriptions',
  'web service':              'Subscriptions',
  'child activities':         'Kids Activities',
  'kids 529 college savings': '529 Contribution',
  'travel & vacation':        'Travel',
  'charity':                  'Shopping',  // no Charity category in FP seed; map to Shopping as fallback
  'interest':                 'Income',
  'paychecks (net)':          'Income',
  'bonus (net)':              'Income',
  'other income':             'Income',
  'transfer':                 'Transfer',
  'credit card payment':      'CC Payment',
  'bitcoin savings':          'Crypto/BTC',
  'mortgage':                 'Utilities',
  'security':                 'Subscriptions',
  'clothing':                 'Shopping',
  'treats':                   'Dining Out',
  'gifts':                    'Shopping',
  'education':                'Kids Activities',
  'postage & shipping':       'Shopping',
  'cash & atm':               'Transfer',
  'personal':                 'Shopping',
  'office supplies & expenses': 'Shopping',
  'miscellaneous':            'Uncategorized',
  'uncategorized':            'Uncategorized',
  'golf':                     'Entertainment',
  'financial fees':           'Utilities'
};

/**
 * Simple string similarity using Dice coefficient on bigrams.
 */
function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.substring(i, i + 2);
      set.set(bi, (set.get(bi) || 0) + 1);
    }
    return set;
  };

  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bi, count] of aB) {
    overlap += Math.min(count, bB.get(bi) || 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * Suggest category mappings for a list of Monarch category names.
 *
 * @param {string[]} monarchCategories - Unique category names from Monarch CSV
 * @param {Array<{id: number, name: string}>} fpCategories - Family Pulse categories from DB
 * @returns {{ mapped: Object<string, {fpName: string, fpId: number, confidence: string}>, unmapped: string[] }}
 */
function suggestMappings(monarchCategories, fpCategories) {
  const mapped = {};
  const unmapped = [];

  for (const mc of monarchCategories) {
    const mcLower = mc.toLowerCase();

    // 1. Check known mappings
    if (KNOWN_MAPPINGS[mcLower]) {
      const fp = fpCategories.find(c => c.name === KNOWN_MAPPINGS[mcLower]);
      if (fp) {
        mapped[mc] = { fpName: fp.name, fpId: fp.id, confidence: 'known' };
        continue;
      }
    }

    // 2. Exact case-insensitive match
    const exact = fpCategories.find(c => c.name.toLowerCase() === mcLower);
    if (exact) {
      mapped[mc] = { fpName: exact.name, fpId: exact.id, confidence: 'exact' };
      continue;
    }

    // 3. Fuzzy match via Dice coefficient
    let bestScore = 0;
    let bestMatch = null;
    for (const fp of fpCategories) {
      const score = diceCoefficient(mcLower, fp.name.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = fp;
      }
    }

    if (bestScore >= 0.4 && bestMatch) {
      mapped[mc] = { fpName: bestMatch.name, fpId: bestMatch.id, confidence: 'fuzzy' };
    } else {
      unmapped.push(mc);
    }
  }

  return { mapped, unmapped };
}

module.exports = { suggestMappings, diceCoefficient, KNOWN_MAPPINGS };
