'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, parseCsvLine } = require('../lib/monarch-parser');

describe('parseCsvLine', () => {
  it('splits simple fields', () => {
    assert.deepStrictEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('handles quoted fields with commas', () => {
    assert.deepStrictEqual(parseCsvLine('"hello, world",b,c'), ['hello, world', 'b', 'c']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    assert.deepStrictEqual(parseCsvLine('"say ""hi""",b'), ['say "hi"', 'b']);
  });

  it('handles empty fields', () => {
    assert.deepStrictEqual(parseCsvLine('a,,c,'), ['a', '', 'c', '']);
  });
});

describe('parse — valid CSV', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures/monarch-sample.csv'), 'utf-8');

  it('parses all rows without errors', () => {
    const result = parse(csv);
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 15);
  });

  it('parses first row correctly', () => {
    const result = parse(csv);
    const row = result.rows[0];
    assert.equal(row.date, '2025-06-15');
    assert.equal(row.merchant, 'Monthly Interest Paid');
    assert.equal(row.category, 'Interest');
    assert.equal(row.account, 'Savings Account (...4455)');
    assert.equal(row.amount, 82.31);
    assert.equal(row.owner, 'Shared');
  });

  it('extracts unique categories', () => {
    const result = parse(csv);
    assert.ok(result.categories.includes('Interest'));
    assert.ok(result.categories.includes('Fast Food'));
    assert.ok(result.categories.includes('Transfer'));
    assert.ok(result.categories.includes('Groceries'));
  });

  it('extracts unique accounts', () => {
    const result = parse(csv);
    assert.ok(result.accounts.includes('Primary Checking (7812)'));
    assert.ok(result.accounts.includes('Savings Account (...4455)'));
    assert.ok(result.accounts.includes('Blue Card (5533)'));
  });

  it('handles negative amounts', () => {
    const result = parse(csv);
    const expense = result.rows.find(r => r.merchant === 'Burger Barn');
    assert.equal(expense.amount, -12.47);
  });
});

describe('parse — edge cases', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures/monarch-edge-cases.csv'), 'utf-8');

  it('parses all edge-case rows', () => {
    const result = parse(csv);
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows.length, 6);
  });

  it('handles commas in quoted merchant name', () => {
    const result = parse(csv);
    const row = result.rows[0];
    assert.equal(row.merchant, 'Merchant, With Commas');
    assert.equal(row.originalStatement, 'MERCHANT, WITH COMMAS INC');
  });

  it('handles empty merchant', () => {
    const result = parse(csv);
    const row = result.rows[1];
    assert.equal(row.merchant, '');
    assert.equal(row.category, 'Uncategorized');
  });

  it('handles zero amount', () => {
    const result = parse(csv);
    const row = result.rows.find(r => r.merchant === 'Zero Dollar');
    assert.equal(row.amount, 0);
  });

  it('handles positive refund amount', () => {
    const result = parse(csv);
    const row = result.rows.find(r => r.merchant === 'Refund Store');
    assert.equal(row.amount, 17.50);
  });

  it('preserves notes, tags, and business entity', () => {
    const result = parse(csv);
    const row = result.rows.find(r => r.merchant === 'Big Purchase');
    assert.equal(row.notes, 'Has a note');
    assert.equal(row.tags, 'vacation');
    assert.equal(row.businessEntity, 'business-co');
    assert.equal(row.amount, -1250.00);
  });
});

describe('parse — error handling', () => {
  it('rejects empty input', () => {
    const result = parse('');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Empty file/);
  });

  it('rejects wrong headers', () => {
    const result = parse('Wrong,Headers,Here\n2025-01-01,a,b');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Invalid header/);
  });

  it('reports invalid dates', () => {
    const csv = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Business Entity\nnot-a-date,Foo,Bar,Acct,Stmt,,10.00,,Shared,';
    const result = parse(csv);
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Invalid date/);
  });

  it('reports invalid amounts', () => {
    const csv = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Business Entity\n2025-01-01,Foo,Bar,Acct,Stmt,,abc,,Shared,';
    const result = parse(csv);
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /Invalid amount/);
  });

  it('accepts Buffer input', () => {
    const csv = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Business Entity\n2025-01-01,Test,Cat,Acct,Stmt,,10.00,,Shared,';
    const result = parse(Buffer.from(csv));
    assert.equal(result.rows.length, 1);
  });
});
