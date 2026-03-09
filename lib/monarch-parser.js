'use strict';

const EXPECTED_HEADERS = [
  'Date', 'Merchant', 'Category', 'Account', 'Original Statement',
  'Notes', 'Amount', 'Tags', 'Owner', 'Business Entity'
];

/**
 * Parse a single CSV line respecting quoted fields.
 * Returns an array of field values.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse Monarch Money CSV export.
 *
 * @param {string|Buffer} input - CSV content
 * @returns {{ rows: object[], errors: object[], categories: string[], accounts: string[] }}
 */
function parse(input) {
  const text = typeof input === 'string' ? input : input.toString('utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: [{ line: 0, message: 'Empty file' }], categories: [], accounts: [] };
  }

  // Validate header
  const headerFields = parseCsvLine(lines[0]);
  const headerNormalized = headerFields.map(h => h.trim());
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    if (headerNormalized[i] !== EXPECTED_HEADERS[i]) {
      return {
        rows: [],
        errors: [{ line: 1, message: `Invalid header: expected "${EXPECTED_HEADERS[i]}" at column ${i + 1}, got "${headerNormalized[i] || '(missing)'}"` }],
        categories: [],
        accounts: []
      };
    }
  }

  const rows = [];
  const errors = [];
  const categorySet = new Set();
  const accountSet = new Set();

  for (let i = 1; i < lines.length; i++) {
    const lineNum = i + 1;
    const fields = parseCsvLine(lines[i]);

    if (fields.length < 7) {
      errors.push({ line: lineNum, message: `Expected at least 7 fields, got ${fields.length}` });
      continue;
    }

    const date = fields[0].trim();
    const merchant = fields[1].trim();
    const category = fields[2].trim();
    const account = fields[3].trim();
    const originalStatement = fields[4].trim();
    const notes = fields[5].trim();
    const amountStr = fields[6].trim();
    const tags = (fields[7] || '').trim();
    const owner = (fields[8] || '').trim();
    const businessEntity = (fields[9] || '').trim();

    // Validate date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
      errors.push({ line: lineNum, message: `Invalid date: "${date}"` });
      continue;
    }

    // Validate amount
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      errors.push({ line: lineNum, message: `Invalid amount: "${amountStr}"` });
      continue;
    }

    if (category) categorySet.add(category);
    if (account) accountSet.add(account);

    rows.push({
      date, merchant, category, account, originalStatement,
      notes, amount, tags, owner, businessEntity, _line: lineNum
    });
  }

  return {
    rows,
    errors,
    categories: [...categorySet].sort(),
    accounts: [...accountSet].sort()
  };
}

module.exports = { parse, parseCsvLine, EXPECTED_HEADERS };
