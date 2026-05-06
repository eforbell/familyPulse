'use strict';

const { pool } = require('../../lib/db');
const { assertNoSecrets } = require('../../lib/secrets-guard');

/**
 * get_transactions — filtered transaction query with pagination and summary mode.
 * Transfers excluded by default.
 */
async function getTransactions({
  date_from, date_to, category, account_name, search,
  include_transfers = false, limit = 50, offset = 0,
  summary_mode = false
} = {}) {
  limit = Math.min(Math.max(1, limit), 200);
  offset = Math.max(0, offset);

  const conditions = ['t.is_hidden = false'];
  const params = [];
  let idx = 1;
  const categoryFilter = typeof category === 'string' ? category.trim() : '';
  const wantsUncategorized = categoryFilter.toLowerCase() === 'uncategorized';

  if (!include_transfers && !wantsUncategorized) {
    conditions.push('t.is_transfer = false');
  }

  if (date_from) {
    params.push(date_from);
    conditions.push(`t.date >= $${idx++}::date`);
  }
  if (date_to) {
    params.push(date_to);
    conditions.push(`t.date <= $${idx++}::date`);
  }
  if (categoryFilter) {
    params.push(categoryFilter);
    if (wantsUncategorized) {
      conditions.push(`COALESCE(c.name, 'Uncategorized') ILIKE $${idx++}`);
    } else {
      conditions.push(`c.name ILIKE $${idx++}`);
    }
  }
  if (account_name) {
    params.push(account_name);
    conditions.push(`COALESCE(a.custom_name, a.name) ILIKE $${idx++}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(t.merchant_name ILIKE $${idx} OR t.name ILIKE $${idx})`);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  if (summary_mode) {
    // Aggregated totals by category
    const sql = `
      SELECT COALESCE(c.name, 'Uncategorized') AS category,
             COUNT(*)::int AS transaction_count,
             ABS(SUM(t.amount) FILTER (WHERE t.amount > 0))::numeric AS total_spending,
             ABS(SUM(t.amount) FILTER (WHERE t.amount < 0))::numeric AS total_income
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      ${whereClause}
      GROUP BY COALESCE(c.name, 'Uncategorized')
      ORDER BY total_spending DESC NULLS LAST`;

    const { rows } = await pool.query(sql, params);
    assertNoSecrets(rows);

    const totalSpending = rows.reduce((s, r) => s + (parseFloat(r.total_spending) || 0), 0);
    const totalIncome = rows.reduce((s, r) => s + (parseFloat(r.total_income) || 0), 0);

    return {
      summary: rows.map(r => ({
        category: r.category,
        transaction_count: r.transaction_count,
        total_spending: parseFloat(r.total_spending) || 0,
        total_income: parseFloat(r.total_income) || 0
      })),
      total_spending: Math.round(totalSpending * 100) / 100,
      total_income: Math.round(totalIncome * 100) / 100,
      net: Math.round((totalIncome - totalSpending) * 100) / 100
    };
  }

  // Detail mode — individual transactions
  const countSql = `
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(t.amount), 0)::numeric AS sum
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN accounts a ON t.account_id = a.id
    ${whereClause}`;
  const { rows: [countRow] } = await pool.query(countSql, params);

  const detailParams = [...params, limit, offset];
  const sql = `
    SELECT t.date, COALESCE(t.merchant_name, t.name) AS merchant,
           t.amount, t.pending,
           COALESCE(c.name, 'Uncategorized') AS category,
           COALESCE(a.custom_name, a.name) AS account_name
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN accounts a ON t.account_id = a.id
    ${whereClause}
    ORDER BY t.date DESC, t.id DESC
    LIMIT $${idx++} OFFSET $${idx++}`;

  const { rows } = await pool.query(sql, detailParams);
  assertNoSecrets(rows);

  return {
    transactions: rows.map(r => ({
      date: r.date,
      merchant: r.merchant,
      amount: parseFloat(r.amount),
      pending: r.pending,
      category: r.category,
      account: r.account_name
    })),
    total: countRow.total,
    sum: parseFloat(countRow.sum),
    limit,
    offset
  };
}

module.exports = { getTransactions };
