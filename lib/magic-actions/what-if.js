'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { chatCompletion } = require('../openai-client');
const { assembleFinancialSnapshot } = require('./context-assembler');
const { sanitizeInput, checkRateLimit } = require('./on-demand');
const logger = require('../logger');

/**
 * Project the impact of a hypothetical financial scenario.
 */
async function forecastScenario(scenario, cfg) {
  const clean = sanitizeInput(scenario);
  if (!clean) {
    return { error: 'Invalid or empty scenario.' };
  }

  // Shared rate limit with on-demand
  let dailyLimit = 10;
  if (cfg) {
    const cfgLimit = await cfg('magic_rate_limit_daily');
    if (cfgLimit) dailyLimit = parseInt(cfgLimit, 10) || 10;
  }

  const allowed = await checkRateLimit(dailyLimit);
  if (!allowed) {
    return { error: 'Daily query limit reached. Try again tomorrow.', rateLimited: true };
  }

  const snapshot = await assembleFinancialSnapshot();
  const snapshotHash = crypto.createHash('md5')
    .update(JSON.stringify(snapshot))
    .digest('hex')
    .slice(0, 12);
  const scenarioHash = crypto.createHash('md5')
    .update(clean + snapshotHash)
    .digest('hex')
    .slice(0, 16);
  const actionType = `what_if_${scenarioHash}`;

  // Check cache
  const { rows: cached } = await pool.query(
    `SELECT output FROM magic_actions_log WHERE action_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [actionType]
  );
  if (cached.length > 0) {
    logger.info('What-if cache hit', { scenarioHash });
    return { forecast: cached[0].output, cached: true };
  }

  let systemPrompt;
  if (cfg) {
    systemPrompt = await cfg('magic_prompt_what_if');
  }
  if (!systemPrompt) {
    systemPrompt = "You are a family finance planner. Given the household's current financial snapshot, project the impact of the described scenario over 3, 6, and 12 months. Clearly communicate uncertainty — use ranges rather than exact numbers. Include caveats about assumptions. Be helpful but honest about limitations.";
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Current financial snapshot:\n\n${JSON.stringify(snapshot, null, 2)}\n\nScenario: ${clean}`
    }
  ];

  const model = process.env.OPENAI_QUERY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const result = await chatCompletion(messages, { model });
  if (!result) {
    logger.info('What-if: LLM unavailable');
    return { forecast: null, cached: false };
  }

  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)`,
    [actionType, JSON.stringify({ scenario: clean }), result.content, result.model, result.tokens_used]
  );

  logger.info('What-if forecast generated', { scenarioHash, model: result.model, tokens: result.tokens_used });
  return { forecast: result.content, cached: false };
}

module.exports = { forecastScenario };
