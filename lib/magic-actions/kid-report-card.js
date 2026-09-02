'use strict';

const { pool } = require('../db');
const { chatCompletion } = require('../openai-client');
const { sanitizeForLLM } = require('../secrets-guard');
const logger = require('../logger');

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly, encouraging money coach for a teenager (age 14-16). ' +
  'Write a brief "Money Report Card" reviewing their spending for the month. ' +
  'Be positive and educational — celebrate wins, gently note areas to watch, ' +
  'and suggest one concrete tip. Use dollar amounts. Keep it to 3-4 short paragraphs. ' +
  'Do not include account numbers or any sensitive information.';

/**
 * Generate a kid-scoped money report card using LLM.
 * Context is strictly limited to the kid's linked accounts — no household data.
 */
async function generateKidReportCard(memberId, period, cfgFn) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const actionType = `kid_report_card_${memberId}_${period}`;

  // Check cache
  const { rows: cached } = await pool.query(
    'SELECT output FROM magic_actions_log WHERE action_type = $1 ORDER BY created_at DESC LIMIT 1',
    [actionType]
  );
  if (cached.length > 0) {
    logger.info('Kid report card cache hit', { memberId, period });
    return { report: cached[0].output, cached: true };
  }

  // Get kid info
  const { rows: [member] } = await pool.query(
    'SELECT name, monthly_budget FROM family_members WHERE id = $1',
    [memberId]
  );
  if (!member) {
    return { report: null, error: 'Member not found' };
  }

  // Get kid's linked account IDs
  const { rows: accountRows } = await pool.query(
    'SELECT account_id FROM account_members WHERE member_id = $1',
    [memberId]
  );
  const accountIds = accountRows.map(r => r.account_id);
  if (accountIds.length === 0) {
    return { report: null, error: 'No linked accounts' };
  }

  // Date range
  const startDate = `${period}-01`;
  const [year, month] = period.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  // Transactions for this period
  const { rows: transactions } = await pool.query(`
    SELECT t.amount, t.date, t.merchant_name, t.name,
           allocation_names.category_name
    FROM transactions t
    LEFT JOIN LATERAL (
      SELECT string_agg(c.name, ' + ' ORDER BY ta.position) AS category_name
      FROM transaction_allocations ta
      LEFT JOIN categories c ON c.id = ta.category_id
      WHERE ta.transaction_id = t.id
    ) allocation_names ON true
    WHERE t.account_id = ANY($1::int[])
      AND t.is_transfer = false
      AND t.is_hidden = false
      AND t.date >= $2::date AND t.date < $3::date
    ORDER BY t.date DESC
  `, [accountIds, startDate, nextMonth]);

  // Category breakdown
  const { rows: categories } = await pool.query(`
    SELECT c.name,
           COALESCE(ABS(SUM(ta.amount) FILTER (WHERE ta.amount > 0)), 0)::numeric AS spent
    FROM categories c
    JOIN transaction_allocations ta ON ta.category_id = c.id
    JOIN transactions t ON t.id = ta.transaction_id
    WHERE t.account_id = ANY($1::int[])
      AND t.is_transfer = false
      AND t.is_hidden = false
      AND t.date >= $2::date AND t.date < $3::date
      AND ta.amount > 0
    GROUP BY c.name
    HAVING SUM(ta.amount) > 0
    ORDER BY spent DESC
  `, [accountIds, startDate, nextMonth]);

  const totalSpent = transactions
    .filter(t => parseFloat(t.amount) > 0)
    .reduce((sum, t) => sum + parseFloat(t.amount), 0);

  const budget = member.monthly_budget ? parseFloat(member.monthly_budget) : null;

  const promptData = sanitizeForLLM({
    kid_name: member.name,
    period,
    total_spending: Math.round(totalSpent * 100) / 100,
    monthly_budget: budget,
    budget_remaining: budget !== null ? Math.round((budget - totalSpent) * 100) / 100 : null,
    categories: categories.map(c => ({
      name: c.name,
      spent: parseFloat(c.spent)
    })),
    transaction_count: transactions.length,
    recent_transactions: transactions.slice(0, 15).map(t => ({
      merchant: t.merchant_name || t.name,
      amount: parseFloat(t.amount),
      date: t.date,
      category: t.category_name
    }))
  });

  // Load system prompt from config or use default
  let systemPrompt = null;
  if (cfgFn) {
    systemPrompt = await cfgFn('magic_prompt_kid_report_card');
  }
  if (!systemPrompt) {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Here is ${member.name}'s financial summary for ${period}:\n\n${JSON.stringify(promptData, null, 2)}\n\nPlease write ${member.name}'s Money Report Card.`
    }
  ];

  const result = await chatCompletion(messages);
  if (!result) {
    logger.info('Kid report card: LLM unavailable, skipping');
    return { report: null, cached: false };
  }

  await pool.query(
    'INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used) VALUES ($1, $2, $3, $4, $5)',
    [actionType, JSON.stringify({ memberId, period }), result.content, result.model, result.tokens_used]
  );

  logger.info('Kid report card generated', { memberId, period, model: result.model, tokens: result.tokens_used });
  return { report: result.content, cached: false };
}

module.exports = { generateKidReportCard };
