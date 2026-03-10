'use strict';

const { pool } = require('./db');
const { getMonthsAgo } = require('./budget-calculator');
const logger = require('./logger');

/**
 * Detect category-level spending anomalies for a given period.
 * Compares current month spending against 3-month and 12-month rolling averages.
 * Pure math — no LLM involved.
 */
async function detectAnomalies(period) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Read thresholds from app_config
  const { rows: cfgRows } = await pool.query(
    `SELECT key, value FROM app_config WHERE key IN ('anomaly_threshold_pct', 'anomaly_min_avg_dollars')`
  );
  const cfg = {};
  for (const r of cfgRows) cfg[r.key] = r.value;
  const thresholdPct = parseFloat(cfg.anomaly_threshold_pct) || 130;
  const minAvgDollars = parseFloat(cfg.anomaly_min_avg_dollars) || 25;

  const startDate = `${period}-01`;
  const [year, month] = period.split('-').map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  // Current month spending by category (non-transfer, non-income)
  const { rows: categorySpending } = await pool.query(`
    SELECT
      c.id AS category_id, c.name AS category_name,
      COALESCE(ABS(SUM(t.amount) FILTER (
        WHERE t.amount > 0 AND t.is_transfer = false
          AND t.date >= $1::date AND t.date < $2::date
      )), 0)::numeric AS spent
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
  `, [startDate, nextMonth]);

  // 3-month rolling average
  const threeMonthsAgo = getMonthsAgo(period, 3);
  const { rows: avg3Rows } = await pool.query(`
    SELECT
      c.id AS category_id,
      COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)), 0)::numeric AS total_spent,
      COUNT(DISTINCT to_char(t.date, 'YYYY-MM')) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)::int AS months_with_data
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
      AND t.date >= $1::date AND t.date < $2::date
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
  `, [threeMonthsAgo, startDate]);

  const avg3Map = {};
  for (const r of avg3Rows) {
    const months = Math.min(r.months_with_data, 3) || 1;
    avg3Map[r.category_id] = parseFloat(r.total_spent) / months;
  }

  // 12-month rolling average
  const twelveMonthsAgo = getMonthsAgo(period, 12);
  const { rows: avg12Rows } = await pool.query(`
    SELECT
      c.id AS category_id,
      COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)), 0)::numeric AS total_spent,
      COUNT(DISTINCT to_char(t.date, 'YYYY-MM')) FILTER (WHERE t.amount > 0 AND t.is_transfer = false)::int AS months_with_data
    FROM categories c
    LEFT JOIN transactions t ON t.category_id = c.id
      AND t.date >= $1::date AND t.date < $2::date
    WHERE c.is_transfer_class = false AND c.is_income = false
      AND c.name != 'Uncategorized'
    GROUP BY c.id
  `, [twelveMonthsAgo, startDate]);

  const avg12Map = {};
  for (const r of avg12Rows) {
    const months = Math.min(r.months_with_data, 12) || 1;
    avg12Map[r.category_id] = parseFloat(r.total_spent) / months;
  }

  // Detect anomalies
  const anomalies = [];

  for (const cat of categorySpending) {
    const spent = parseFloat(cat.spent);
    const avg3 = avg3Map[cat.category_id] || 0;
    const avg12 = avg12Map[cat.category_id] || 0;

    // Skip if both averages below minimum threshold
    if (avg3 < minAvgDollars && avg12 < minAvgDollars) continue;
    // Skip if no spending this month
    if (spent === 0) continue;

    const pct3 = avg3 > 0 ? (spent / avg3) * 100 : 0;
    const pct12 = avg12 > 0 ? (spent / avg12) * 100 : 0;

    if (avg3 >= minAvgDollars && pct3 > thresholdPct) {
      anomalies.push({
        category_id: cat.category_id,
        category_name: cat.category_name,
        anomaly_type: 'spending_spike_3mo',
        period,
        current_amount: spent,
        avg_3mo: Math.round(avg3 * 100) / 100,
        avg_12mo: Math.round(avg12 * 100) / 100,
        pct_of_3mo: Math.round(pct3 * 10) / 10,
        pct_of_12mo: Math.round(pct12 * 10) / 10
      });
    }

    if (avg12 >= minAvgDollars && pct12 > thresholdPct) {
      anomalies.push({
        category_id: cat.category_id,
        category_name: cat.category_name,
        anomaly_type: 'spending_spike_12mo',
        period,
        current_amount: spent,
        avg_3mo: Math.round(avg3 * 100) / 100,
        avg_12mo: Math.round(avg12 * 100) / 100,
        pct_of_3mo: Math.round(pct3 * 10) / 10,
        pct_of_12mo: Math.round(pct12 * 10) / 10
      });
    }
  }

  // Upsert into anomalies table
  for (const a of anomalies) {
    await pool.query(`
      INSERT INTO anomalies (category_id, anomaly_type, period, current_amount, avg_3mo, avg_12mo, pct_of_3mo, pct_of_12mo, severity, detected_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'warning', now())
      ON CONFLICT (category_id, period, anomaly_type) DO UPDATE SET
        current_amount = EXCLUDED.current_amount,
        avg_3mo = EXCLUDED.avg_3mo,
        avg_12mo = EXCLUDED.avg_12mo,
        pct_of_3mo = EXCLUDED.pct_of_3mo,
        pct_of_12mo = EXCLUDED.pct_of_12mo,
        detected_at = now()
    `, [a.category_id, a.anomaly_type, a.period, a.current_amount, a.avg_3mo, a.avg_12mo, a.pct_of_3mo, a.pct_of_12mo]);
  }

  logger.info('Anomaly detection complete', { period, total: anomalies.length });
  return { period, total: anomalies.length, anomalies };
}

module.exports = { detectAnomalies };
