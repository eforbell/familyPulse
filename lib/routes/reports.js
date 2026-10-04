'use strict';

const { Router } = require('express');
const { BURN_MODES, SANKEY_RANGES, addDays, householdToday, getSpendingBurn, getCashFlowSankey } = require('../reports');
const { requireAuth, requireParent } = require('../auth');

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

// ── GET /api/household/date ─────────────────────────────────
// Calendar "today" for the household. Browsers can sit in other timezones,
// so date windows the household reasons about come from here.

router.get('/api/household/date', requireAuth, (req, res) => {
  const today = householdToday();
  res.json({ today, yesterday: addDays(today, -1) });
});

module.exports = router;
