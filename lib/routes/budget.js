'use strict';

const { Router } = require('express');
const { getMonthlyBudgetSummary, getCategoryDetail } = require('../budget-calculator');
const { generateSnapshot, backfillSnapshots } = require('../snapshot-generator');

const router = Router();

// ── GET /api/budget/summary ─────────────────────────────────

router.get('/api/budget/summary', async (req, res) => {
  try {
    const period = req.query.period || null;
    const summary = await getMonthlyBudgetSummary(period);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/budget/category/:id ────────────────────────────

router.get('/api/budget/category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const period = req.query.period || null;
    const detail = await getCategoryDetail(parseInt(id), period);

    if (!detail) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/budget/snapshot ───────────────────────────────

router.post('/api/budget/snapshot', async (req, res) => {
  try {
    const { period } = req.body;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: 'period is required in YYYY-MM format' });
    }
    const result = await generateSnapshot(period);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/budget/backfill ───────────────────────────────

router.post('/api/budget/backfill', async (req, res) => {
  try {
    const result = await backfillSnapshots();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
