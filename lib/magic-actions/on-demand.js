'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { chatCompletion } = require('../openai-client');
const { assembleQueryContext } = require('./context-assembler');
const logger = require('../logger');

// Preset questions
const PRESET_QUESTIONS = [
  'How are we tracking against budget this month?',
  "What's our biggest discretionary spend this quarter?",
  'Summarize our spending trends over the last 3 months'
];

// ── Intent schema for structured pre-parse ────────────────────

const INTENT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'query_intent',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        start_period: {
          type: 'string',
          description: 'YYYY-MM start of the date range the question is about'
        },
        end_period: {
          type: 'string',
          description: 'YYYY-MM end of the date range (inclusive)'
        },
        focus: {
          type: 'string',
          enum: ['budget', 'merchants', 'accounts', 'general'],
          description: 'What type of data the question is primarily about'
        }
      },
      required: ['start_period', 'end_period', 'focus'],
      additionalProperties: false
    }
  }
};

/**
 * Sanitize user input: strip HTML, limit length, reject secret-like patterns.
 */
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return null;
  let clean = text.replace(/<[^>]*>/g, '');
  clean = clean.slice(0, 500).trim();
  const secretPatterns = [
    /access-sandbox-[a-f0-9-]+/i,
    /access-production-[a-f0-9-]+/i,
    /sk-[a-zA-Z0-9_-]{20,}/,
    /plaid_secret_/i
  ];
  for (const p of secretPatterns) {
    if (p.test(clean)) return null;
  }
  return clean || null;
}

/**
 * Check rate limit: count on_demand + what_if actions in last 24h.
 */
async function checkRateLimit(dailyLimit) {
  const { rows: [{ count }] } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM magic_actions_log
    WHERE (action_type LIKE 'on_demand_%' OR action_type LIKE 'what_if_%')
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  return count < dailyLimit;
}

/**
 * Get today's usage count.
 */
async function getUsageCount() {
  const { rows: [{ count }] } = await pool.query(`
    SELECT COUNT(*)::int AS count FROM magic_actions_log
    WHERE (action_type LIKE 'on_demand_%' OR action_type LIKE 'what_if_%')
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  return count;
}

/**
 * Pre-parse a question to determine the time frame and data focus.
 * Uses a cheap structured-output call (minimal reasoning).
 */
async function parseIntent(question) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const result = await chatCompletion([
    {
      role: 'system',
      content: `You parse financial questions to determine what data to fetch. Today is ${today}. Return the date range (YYYY-MM) and data focus. "this month" = ${today} to ${today}. "this quarter" = last 3 months ending ${today}. "last 3 months" = 3 months ending ${today}. "this year" = January to ${today}. Focus: "budget" for budget/category questions, "merchants" for spending/merchant questions, "accounts" for balance questions, "general" for mixed.`
    },
    { role: 'user', content: question }
  ], {
    model,
    response_format: INTENT_SCHEMA,
    max_tokens: 200,
    reasoning_effort: 'minimal'
  });

  if (!result || !result.content) {
    // Fallback: current month, general
    logger.info('Intent parse: LLM unavailable, using defaults');
    return { start_period: today, end_period: today, focus: 'general' };
  }

  try {
    const parsed = JSON.parse(result.content);
    logger.info('Intent parsed', { question: question.slice(0, 60), ...parsed, tokens: result.tokens_used });
    return parsed;
  } catch {
    logger.warn('Intent parse: invalid JSON, using defaults');
    return { start_period: today, end_period: today, focus: 'general' };
  }
}

/**
 * Answer a preset or free-form financial question.
 */
async function analyzeQuestion(question, period, cfg) {
  const clean = sanitizeInput(question);
  if (!clean) {
    return { error: 'Invalid or empty question.' };
  }

  // Rate limit
  let dailyLimit = 10;
  if (cfg) {
    const cfgLimit = await cfg('magic_rate_limit_daily');
    if (cfgLimit) dailyLimit = parseInt(cfgLimit, 10) || 10;
  }

  const allowed = await checkRateLimit(dailyLimit);
  if (!allowed) {
    return { error: 'Daily query limit reached. Try again tomorrow.', rateLimited: true };
  }

  // Step 1: Pre-parse to determine time frame and data focus
  const intent = await parseIntent(clean);

  // Step 2: Assemble context based on intent
  const contextData = await assembleQueryContext(intent);

  // Cache key from question + intent + data hash
  const dataHash = crypto.createHash('md5')
    .update(JSON.stringify(contextData))
    .digest('hex')
    .slice(0, 12);
  const questionHash = crypto.createHash('md5')
    .update(clean + dataHash)
    .digest('hex')
    .slice(0, 16);
  const actionType = `on_demand_${questionHash}`;

  // Check cache
  const { rows: cached } = await pool.query(
    `SELECT output FROM magic_actions_log WHERE action_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [actionType]
  );
  if (cached.length > 0) {
    logger.info('On-demand cache hit', { questionHash });
    return { answer: cached[0].output, cached: true };
  }

  // Step 3: Answer the question
  let systemPrompt;
  if (cfg) {
    systemPrompt = await cfg('magic_prompt_on_demand');
  }
  if (!systemPrompt) {
    systemPrompt = "You are a family finance assistant. Answer the user's financial question using only the data provided. Be specific with dollar amounts and percentages. If the data is insufficient to answer fully, say so. Do not make up numbers. Keep the response concise and helpful.";
  }

  const rangeLabel = intent.start_period === intent.end_period
    ? intent.start_period
    : `${intent.start_period} through ${intent.end_period}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Financial data for ${rangeLabel}:\n\n${JSON.stringify(contextData, null, 2)}\n\nQuestion: ${clean}`
    }
  ];

  const model = process.env.OPENAI_QUERY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const result = await chatCompletion(messages, { model });
  if (!result) {
    logger.info('On-demand: LLM unavailable');
    return { answer: null, cached: false };
  }

  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)`,
    [actionType, JSON.stringify({ question: clean, intent }), result.content, result.model, result.tokens_used]
  );

  logger.info('On-demand answer generated', { questionHash, intent, model: result.model, tokens: result.tokens_used });
  return { answer: result.content, cached: false };
}

module.exports = { analyzeQuestion, sanitizeInput, checkRateLimit, getUsageCount, PRESET_QUESTIONS };
