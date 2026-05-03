'use strict';

const { pool } = require('../db');
const { chatCompletion } = require('../openai-client');
const { assembleWeeklyContext } = require('./context-assembler');
const logger = require('../logger');

/**
 * Generate a weekly spending digest using LLM.
 * Caches in magic_actions_log to avoid duplicate calls.
 */
async function generateWeeklyDigest(period, cfg) {
  if (!period) {
    period = currentWeeklyDigestPeriod();
  }

  const actionType = `weekly_digest_${period}`;

  // Check cache
  const { rows: cached } = await pool.query(
    `SELECT output FROM magic_actions_log WHERE action_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [actionType]
  );
  if (cached.length > 0) {
    logger.info('Weekly digest cache hit', { period });
    return { digest: cached[0].output, cached: true };
  }

  // Gather context
  const promptData = await assembleWeeklyContext(period);

  // Load system prompt from config or use default
  let systemPrompt;
  if (cfg) {
    systemPrompt = await cfg('magic_prompt_weekly_digest');
  }
  if (!systemPrompt) {
    systemPrompt = 'You are a helpful family finance assistant. Write a brief, friendly weekly spending digest in plain English. Highlight any spending spikes or anomalies. Keep it to 3-5 short paragraphs. Use dollar amounts. Do not include account numbers or sensitive information.';
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Here is the financial summary for ${period}:\n\n${JSON.stringify(promptData, null, 2)}\n\nPlease write a friendly weekly spending digest.`
    }
  ];

  // Use lightweight model (OPENAI_ANOMALY_DIGEST_MODEL)
  const result = await chatCompletion(messages);
  if (!result) {
    logger.info('Weekly digest: LLM unavailable, skipping');
    return { digest: null, cached: false };
  }

  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)`,
    [actionType, JSON.stringify({ period }), result.content, result.model, result.tokens_used]
  );

  logger.info('Weekly digest generated', { period, model: result.model, tokens: result.tokens_used });
  return { digest: result.content, cached: false };
}

function currentWeeklyDigestPeriod(now = new Date()) {
  const periodDate = new Date(now);
  const day = periodDate.getDay();
  const usePreviousSunday = day === 0 && periodDate.getHours() < 18;
  const daysSinceSunday = usePreviousSunday ? 7 : day;

  periodDate.setHours(0, 0, 0, 0);
  periodDate.setDate(periodDate.getDate() - daysSinceSunday);

  const year = periodDate.getFullYear();
  const month = String(periodDate.getMonth() + 1).padStart(2, '0');
  const date = String(periodDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

module.exports = { generateWeeklyDigest, currentWeeklyDigestPeriod };
