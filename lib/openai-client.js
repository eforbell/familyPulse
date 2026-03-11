'use strict';

const logger = require('./logger');

/**
 * Thin wrapper around the OpenAI SDK.
 * Returns null gracefully if no API key or if the SDK isn't installed.
 */
async function chatCompletion(messages, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('OpenAI: no API key configured, skipping');
    return null;
  }

  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch {
    logger.warn('OpenAI: openai package not installed, skipping');
    return null;
  }

  const model = opts.model
    || process.env.OPENAI_ANOMALY_DIGEST_MODEL
    || process.env.OPENAI_MODEL
    || 'gpt-4o-mini';

  try {
    const client = new OpenAI({ apiKey });
    const params = {
      model,
      messages,
      max_completion_tokens: opts.max_tokens ?? 4096,
      reasoning_effort: opts.reasoning_effort ?? 'low'
    };
    // Some models (e.g. o-series, gpt-5) only support temperature=1
    if (opts.temperature !== undefined) {
      params.temperature = opts.temperature;
    }
    // Structured outputs (json_schema) — forces model to produce content
    if (opts.response_format) {
      params.response_format = opts.response_format;
    }
    const response = await client.chat.completions.create(params);
    const content = response.choices[0]?.message?.content || '';
    const tokens = response.usage?.total_tokens || 0;
    if (!content && tokens > 0) {
      logger.warn('OpenAI: model used tokens but returned empty content', {
        model, tokens, finish_reason: response.choices[0]?.finish_reason
      });
    }
    return { content, model, tokens_used: tokens };
  } catch (err) {
    logger.error('OpenAI API call failed', { error: err.message });
    return null;
  }
}

module.exports = { chatCompletion };
