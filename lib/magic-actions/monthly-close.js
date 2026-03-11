'use strict';

const { pool } = require('../db');
const { chatCompletion } = require('../openai-client');
const { assembleMonthlyContext } = require('./context-assembler');
const logger = require('../logger');

/**
 * Generate a monthly close report for a completed month.
 */
async function generateMonthlyClose(period, cfg) {
  if (!period) {
    const now = new Date();
    // Default to prior month (since close is for a completed month)
    const prior = now.getMonth() === 0
      ? `${now.getFullYear() - 1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
    period = prior;
  }

  const actionType = `monthly_close_${period}`;

  // Check cache
  const { rows: cached } = await pool.query(
    `SELECT output FROM magic_actions_log WHERE action_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [actionType]
  );
  if (cached.length > 0) {
    logger.info('Monthly close cache hit', { period });
    return { report: cached[0].output, period, cached: true };
  }

  // Gather context
  const promptData = await assembleMonthlyContext(period);

  let systemPrompt;
  if (cfg) {
    systemPrompt = await cfg('magic_prompt_monthly_close');
  }
  if (!systemPrompt) {
    systemPrompt = 'You are a family finance assistant for the Forbell household (Eric, Alex, Jordan, Casey). Write a concise monthly close report. Summarize income vs spending, highlight categories that were over or under budget, note wins and areas to watch. Compare to the prior month and 3-month averages. Keep it friendly and actionable, 4-6 paragraphs.';
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Here is the monthly financial data for ${period}:\n\n${JSON.stringify(promptData, null, 2)}\n\nPlease write a monthly close report.`
    }
  ];

  // Use lightweight model (OPENAI_ANOMALY_DIGEST_MODEL)
  const result = await chatCompletion(messages);
  if (!result) {
    logger.info('Monthly close: LLM unavailable, skipping');
    return { report: null, period, cached: false };
  }

  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)`,
    [actionType, JSON.stringify({ period }), result.content, result.model, result.tokens_used]
  );

  logger.info('Monthly close generated', { period, model: result.model, tokens: result.tokens_used });
  return { report: result.content, period, cached: false };
}

module.exports = { generateMonthlyClose };
