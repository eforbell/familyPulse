'use strict';

const { pool } = require('./db');
const { chatCompletion } = require('./openai-client');
const { getMonthlyBudgetSummary } = require('./budget-calculator');
const { sanitizeForLLM } = require('./secrets-guard');
const logger = require('./logger');

/**
 * Generate a weekly spending digest using LLM.
 * Caches in magic_actions_log to avoid duplicate calls.
 * Gracefully degrades if no API key or API failure.
 */
async function generateWeeklyDigest(period) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

  // Gather data
  const budgetSummary = await getMonthlyBudgetSummary(period);

  const { rows: anomalies } = await pool.query(`
    SELECT a.anomaly_type, a.current_amount, a.avg_3mo, a.avg_12mo, a.pct_of_3mo, a.pct_of_12mo,
           c.name AS category_name
    FROM anomalies a
    JOIN categories c ON a.category_id = c.id
    WHERE a.period = $1
    ORDER BY a.current_amount DESC
  `, [period]);

  // Build prompt — no secrets, no account numbers, no PII beyond first names
  const promptData = sanitizeForLLM({
    period,
    income: budgetSummary.income.current,
    total_spending: budgetSummary.spending.actual,
    total_budgeted: budgetSummary.spending.budgeted,
    net_cash_flow: budgetSummary.net_cash_flow.current,
    categories: budgetSummary.categories.map(c => ({
      name: c.name,
      spent: c.spent,
      budgeted: c.budgeted,
      pct_used: c.pct_used,
      avg_3mo: c.avg_3mo
    })),
    anomalies: anomalies.map(a => ({
      category: a.category_name,
      type: a.anomaly_type,
      current: parseFloat(a.current_amount),
      avg_3mo: parseFloat(a.avg_3mo),
      avg_12mo: parseFloat(a.avg_12mo),
      pct_of_3mo: parseFloat(a.pct_of_3mo),
      pct_of_12mo: parseFloat(a.pct_of_12mo)
    })),
    family: ['Eric', 'Alex', 'Jordan', 'Casey']
  });

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful family finance assistant for the Forbell household (Eric, Alex, Jordan, Casey). Write a brief, friendly weekly spending digest in plain English. Highlight any spending spikes or anomalies. Keep it to 3-5 short paragraphs. Use dollar amounts. Do not include account numbers or sensitive information.'
    },
    {
      role: 'user',
      content: `Here is the financial summary for ${period}:\n\n${JSON.stringify(promptData, null, 2)}\n\nPlease write a friendly weekly spending digest.`
    }
  ];

  const result = await chatCompletion(messages);
  if (!result) {
    logger.info('Weekly digest: LLM unavailable, skipping');
    return { digest: null, cached: false };
  }

  // Cache the digest
  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)`,
    [actionType, JSON.stringify({ period }), result.content, result.model, result.tokens_used]
  );

  logger.info('Weekly digest generated', { period, model: result.model, tokens: result.tokens_used });
  return { digest: result.content, cached: false };
}

module.exports = { generateWeeklyDigest };
