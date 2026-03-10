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
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 1024
    });
    return {
      content: response.choices[0]?.message?.content || '',
      model,
      tokens_used: response.usage?.total_tokens || 0
    };
  } catch (err) {
    logger.error('OpenAI API call failed', { error: err.message });
    return null;
  }
}

module.exports = { chatCompletion };
