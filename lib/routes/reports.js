'use strict';

const { Router } = require('express');
const { BURN_MODES, SANKEY_RANGES, getSpendingBurn, getCashFlowSankey } = require('../reports');
const { requireParent } = require('../auth');

const router = Router();

// ── GET /api/reports/spending-burn ──────────────────────────

router.get('/api/reports/spending-burn', requireParent, async (req, res) => {
  try {
    const mode = req.query.mode || 'month_vs_last_month';
    if (!Object.hasOwn(BURN_MODES, mode)) {
      return res.status(400).json({ error: `mode must be one of: ${Object.keys(BURN_MODES).join(', ')}` });
    }
    res.json(await getSpendingBurn(mode));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/cash-flow-sankey ───────────────────────

router.get('/api/reports/cash-flow-sankey', requireParent, async (req, res) => {
  try {
    const range = req.query.range || 'this_month';
    if (!Object.hasOwn(SANKEY_RANGES, range)) {
      return res.status(400).json({ error: `range must be one of: ${Object.keys(SANKEY_RANGES).join(', ')}` });
    }
    res.json(await getCashFlowSankey(range));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
