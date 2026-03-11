'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { supportsReasoningEffort } = require('../lib/openai-client');

describe('OpenAI client model gating', () => {
  it('does not send reasoning_effort to gpt-4o-mini style chat models', () => {
    assert.equal(supportsReasoningEffort('gpt-4o-mini'), false);
  });

  it('allows reasoning_effort for gpt-5 models', () => {
    assert.equal(supportsReasoningEffort('gpt-5-mini'), true);
  });

  it('allows reasoning_effort for o-series models', () => {
    assert.equal(supportsReasoningEffort('o4-mini'), true);
  });
});
