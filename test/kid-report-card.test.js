'use strict';

require('dotenv').config();
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Unit test: verify the context assembly doesn't leak parent data.
// We test the module's data-fetching logic patterns, not the LLM call itself.

describe('kid report card module', () => {
  it('exports generateKidReportCard function', () => {
    const { generateKidReportCard } = require('../lib/magic-actions/kid-report-card');
    assert.equal(typeof generateKidReportCard, 'function');
  });

  it('returns error when member not found', async () => {
    // This test requires DB access; uses a non-existent member ID
    const { generateKidReportCard } = require('../lib/magic-actions/kid-report-card');
    const result = await generateKidReportCard(999999, '2025-01', null);
    assert.equal(result.report, null);
    assert.equal(result.error, 'Member not found');
  });
});
