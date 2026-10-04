'use strict';

const { pool } = require('../../lib/db');
const { assertNoSecrets } = require('../../lib/secrets-guard');

/**
 * get_anomalies — spending spikes from the anomalies table.
 * Reads existing detected anomalies; does not re-detect.
 */
async function getAnomalies({ period, include_acknowledged = false } = {}) {
  if (!period) {
    const now = new Date();
    period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const conditions = ['a.period = $1', 'c.exclude_from_spending = false'];
  const params = [period];

  if (!include_acknowledged) {
    conditions.push('a.acknowledged = false');
  }

  const sql = `
    SELECT a.anomaly_type, a.period, a.severity,
           a.current_amount, a.avg_3mo, a.avg_12mo,
           a.pct_of_3mo, a.pct_of_12mo, a.note,
           a.acknowledged,
           c.name AS category_name
    FROM anomalies a
    JOIN categories c ON a.category_id = c.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.current_amount DESC`;

  const { rows } = await pool.query(sql, params);
  assertNoSecrets(rows);

  return {
    period,
    total: rows.length,
    anomalies: rows.map(r => ({
      category: r.category_name,
      type: r.anomaly_type,
      severity: r.severity,
      current_amount: parseFloat(r.current_amount),
      avg_3mo: parseFloat(r.avg_3mo),
      avg_12mo: parseFloat(r.avg_12mo),
      pct_of_3mo: parseFloat(r.pct_of_3mo),
      pct_of_12mo: parseFloat(r.pct_of_12mo),
      note: r.note,
      acknowledged: r.acknowledged
    }))
  };
}

module.exports = { getAnomalies };
