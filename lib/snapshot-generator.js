'use strict';

const { pool } = require('./db');

/**
 * Generate a budget snapshot for a single period (YYYY-MM).
 * Upserts actual_spent + budgeted from live data.
 */
async function generateSnapshot(period) {
  const startDate = `${period}-01`;
  const [year, month] = period.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const { rowCount } = await pool.query(`
    INSERT INTO budget_snapshots (category_id, period, budgeted, actual_spent, updated_at)
    SELECT
      c.id,
      $1,
      COALESCE(c.budget_amount, 0),
      COALESCE(ABS(SUM(ta.amount) FILTER (
        WHERE ta.amount > 0
          AND t.is_transfer = false
          AND t.is_hidden = false
          AND t.date >= $2::date AND t.date < $3::date
      )), 0),
      now()
    FROM categories c
    LEFT JOIN transaction_allocations ta ON ta.category_id = c.id
    LEFT JOIN transactions t ON t.id = ta.transaction_id
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
    ON CONFLICT (category_id, period)
    DO UPDATE SET
      budgeted = EXCLUDED.budgeted,
      actual_spent = EXCLUDED.actual_spent,
      updated_at = now()
  `, [period, startDate, nextMonth]);

  return { period, rows_upserted: rowCount };
}

/**
 * Backfill snapshots from earliest transaction through last complete month.
 */
async function backfillSnapshots() {
  const { rows: [earliest] } = await pool.query(
    `SELECT MIN(date) AS min_date FROM transactions WHERE is_transfer = false AND is_hidden = false`
  );

  if (!earliest || !earliest.min_date) {
    return { periods: 0, message: 'No transactions found' };
  }

  const start = new Date(earliest.min_date);
  const now = new Date();
  // Last complete month = month before current
  const endYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const endMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth is 0-based

  const results = [];
  let y = start.getFullYear();
  let m = start.getMonth() + 1;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const period = `${y}-${String(m).padStart(2, '0')}`;
    const result = await generateSnapshot(period);
    results.push(result);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  return { periods: results.length, results };
}

module.exports = { generateSnapshot, backfillSnapshots };
