'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { generateWeeklyDigest } = require('../magic-actions/weekly-digest');
const { generateMonthlyClose } = require('../magic-actions/monthly-close');
const { analyzeQuestion, getUsageCount, PRESET_QUESTIONS } = require('../magic-actions/on-demand');
const { forecastScenario } = require('../magic-actions/what-if');

const router = Router();

// Parent-only enforcement is handled by the blanket API gate in server.js
// (all /api/magic/* routes require parent role)

// ── Config helpers (loaded from server.js exports) ────────────

function getCfg(req) {
  return req.app.get('cfg');
}

// ── GET /api/magic/digest — weekly digest ─────────────────────

router.get('/api/magic/digest', async (req, res) => {
  try {
    const period = req.query.period || currentPeriod();
    const result = await generateWeeklyDigest(period, getCfg(req));
    res.json({ period, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/magic/monthly — monthly close report ─────────────

router.get('/api/magic/monthly', async (req, res) => {
  try {
    const period = req.query.period || null;
    const result = await generateMonthlyClose(period, getCfg(req));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/magic/history — past reports ─────────────────────

router.get('/api/magic/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, action_type, input, output, model, tokens_used, created_at
      FROM magic_actions_log
      WHERE action_type LIKE 'weekly_digest_%'
         OR action_type LIKE 'monthly_close_%'
         OR action_type LIKE 'on_demand_%'
         OR action_type LIKE 'what_if_%'
      ORDER BY created_at DESC
      LIMIT 100
    `);
    const reports = rows
      .filter(r => r.action_type.startsWith('weekly_digest') || r.action_type.startsWith('monthly_close'))
      .map(r => ({
      id: r.id,
      type: r.action_type.startsWith('weekly_digest') ? 'weekly' : 'monthly',
      period: r.action_type.replace(/^(weekly_digest_|monthly_close_)/, ''),
      content: r.output,
      model: r.model,
      tokens: r.tokens_used,
      created_at: r.created_at
      }));

    const queries = rows
      .filter(r => r.action_type.startsWith('on_demand_') || r.action_type.startsWith('what_if_'))
      .map(r => {
        let parsedInput = {};
        try {
          parsedInput = r.input ? JSON.parse(r.input) : {};
        } catch {
          parsedInput = {};
        }

        return {
          id: r.id,
          type: r.action_type.startsWith('on_demand_') ? 'ask' : 'what_if',
          prompt: parsedInput.question || parsedInput.scenario || 'Untitled prompt',
          content: r.output,
          model: r.model,
          tokens: r.tokens_used,
          created_at: r.created_at
        };
      });

    res.json({ reports, queries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/magic/ask — on-demand question ──────────────────

router.post('/api/magic/ask', async (req, res) => {
  try {
    const { question, period } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    const result = await analyzeQuestion(question, period, getCfg(req));
    if (result.rateLimited) {
      return res.status(429).json({ error: result.error });
    }
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/magic/what-if — scenario forecast ───────────────

router.post('/api/magic/what-if', async (req, res) => {
  try {
    const { scenario } = req.body;
    if (!scenario) {
      return res.status(400).json({ error: 'Scenario is required' });
    }
    const result = await forecastScenario(scenario, getCfg(req));
    if (result.rateLimited) {
      return res.status(429).json({ error: result.error });
    }
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/magic/presets — preset question list ─────────────

router.get('/api/magic/presets', async (req, res) => {
  res.json({ presets: PRESET_QUESTIONS });
});

// ── GET /api/magic/config — prompt settings ───────────────────

router.get('/api/magic/config', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key LIKE 'magic_%' ORDER BY key`
    );
    // Also get usage stats
    const usage = await getUsageCount();
    const cfg = getCfg(req);
    const dailyLimit = cfg ? parseInt(await cfg('magic_rate_limit_daily') || '10', 10) : 10;

    // Total tokens this month
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const { rows: [tokenRow] } = await pool.query(
      `SELECT COALESCE(SUM(tokens_used), 0)::int AS total_tokens FROM magic_actions_log WHERE created_at >= $1::date`,
      [monthStart]
    );

    res.json({
      config: rows,
      usage: {
        queries_today: usage,
        daily_limit: dailyLimit,
        tokens_this_month: tokenRow.total_tokens
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/magic/config/:key — update prompt setting ────────

router.put('/api/magic/config/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (!key.startsWith('magic_')) {
      return res.status(400).json({ error: 'Can only update magic_* config keys' });
    }
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'Value is required' });
    }
    const setCfg = req.app.get('setCfg');
    await setCfg(key, value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = router;
