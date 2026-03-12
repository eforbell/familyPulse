'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { detectAnomalies } = require('../anomaly-detector');

const router = Router();

// ── GET /api/anomalies — unacknowledged anomalies for period ──

router.get('/api/anomalies', async (req, res) => {
  try {
    const period = req.query.period || getCurrentPeriod();
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (a.category_id)
             a.id, a.anomaly_type, a.period, a.current_amount, a.avg_3mo, a.avg_12mo,
             a.pct_of_3mo, a.pct_of_12mo, a.severity, a.note, a.detected_at,
             c.id AS category_id, c.name AS category_name, c.icon, c.color
      FROM anomalies a
      JOIN categories c ON a.category_id = c.id
      WHERE a.period = $1 AND a.acknowledged = false
      ORDER BY a.category_id,
               GREATEST(COALESCE(a.pct_of_3mo, 0), COALESCE(a.pct_of_12mo, 0)) DESC,
               a.detected_at DESC
    `, [period]);
    rows.sort((a, b) => parseFloat(b.current_amount) - parseFloat(a.current_amount));
    res.json({ period, anomalies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/anomalies/history — past acknowledged anomalies ──

router.get('/api/anomalies/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.anomaly_type, a.period, a.current_amount, a.avg_3mo, a.avg_12mo,
             a.pct_of_3mo, a.pct_of_12mo, a.severity, a.note, a.detected_at,
             c.id AS category_id, c.name AS category_name, c.icon, c.color
      FROM anomalies a
      JOIN categories c ON a.category_id = c.id
      WHERE a.acknowledged = true
      ORDER BY a.detected_at DESC
      LIMIT 100
    `);
    res.json({ anomalies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/anomalies/:id/acknowledge ──

router.put('/api/anomalies/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const note = req.body?.note || null;
    const { rowCount } = await pool.query(
      `UPDATE anomalies SET acknowledged = true, note = COALESCE($1, note) WHERE id = $2`,
      [note, id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Anomaly not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/anomalies/detect — trigger detection manually ──

router.post('/api/anomalies/detect', async (req, res) => {
  try {
    const period = req.body?.period || null;
    const result = await detectAnomalies(period);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
