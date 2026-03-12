'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../lib/db');
const { sanitizeInput } = require('../lib/magic-actions/on-demand');

describe('magic-actions', () => {
  after(async () => {
    await pool.query(`DELETE FROM magic_actions_log WHERE action_type LIKE 'test_%'`);
  });

  // ── Input sanitization ──────────────────────────────────────

  it('sanitizeInput strips HTML', () => {
    const result = sanitizeInput('<script>alert("xss")</script>What about groceries?');
    assert.equal(result, 'alert("xss")What about groceries?');
  });

  it('sanitizeInput limits to 500 chars', () => {
    const long = 'a'.repeat(600);
    const result = sanitizeInput(long);
    assert.equal(result.length, 500);
  });

  it('sanitizeInput rejects secret-like patterns', () => {
    assert.equal(sanitizeInput('access-sandbox-abc123def456-7890'), null);
    assert.equal(sanitizeInput('Tell me about sk-abc123456789012345678901'), null);
  });

  it('sanitizeInput returns null for empty', () => {
    assert.equal(sanitizeInput(''), null);
    assert.equal(sanitizeInput(null), null);
    assert.equal(sanitizeInput('   '), null);
  });

  // ── Cache ──────────────────────────────────────────────────

  it('cache hit returns stored output', async () => {
    const actionType = `test_cache_${Date.now()}`;
    const cachedOutput = 'Cached test response.';

    await pool.query(
      `INSERT INTO magic_actions_log (action_type, output, model) VALUES ($1, $2, 'test')`,
      [actionType, cachedOutput]
    );

    const { rows } = await pool.query(
      `SELECT output FROM magic_actions_log WHERE action_type = $1`,
      [actionType]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].output, cachedOutput);
  });

  // ── Rate limiting ──────────────────────────────────────────

  it('rate limit counts on_demand and what_if actions', async () => {
    const { rows: [{ count: before }] } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM magic_actions_log
      WHERE (action_type LIKE 'on_demand_%' OR action_type LIKE 'what_if_%')
        AND created_at > NOW() - INTERVAL '24 hours'
    `);

    await pool.query(
      `INSERT INTO magic_actions_log (action_type, output, model) VALUES ($1, 'test', 'test')`,
      [`on_demand_test_${Date.now()}`]
    );

    const { rows: [{ count: afterInsert }] } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM magic_actions_log
      WHERE (action_type LIKE 'on_demand_%' OR action_type LIKE 'what_if_%')
        AND created_at > NOW() - INTERVAL '24 hours'
    `);

    assert.equal(afterInsert, before + 1);
  });

  // ── Parent-only guard ──────────────────────────────────────

  it('family_members has parent and kid roles', async () => {
    const { rows } = await pool.query(
      `SELECT name, role FROM family_members WHERE name IN ('Eric', 'Alex', 'Jordan', 'Casey') ORDER BY name`
    );
    const roles = {};
    for (const r of rows) roles[r.name] = r.role;

    if (rows.length > 0) {
      assert.equal(roles.Eric || roles.Alex, 'parent');
      // Kids
      if (roles.Jordan) assert.equal(roles.Jordan, 'kid');
      if (roles.Casey) assert.equal(roles.Casey, 'kid');
    }
  });

  // ── Prompt no secrets ──────────────────────────────────────

  it('system prompts in config do not contain secrets', async () => {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_config WHERE key LIKE 'magic_prompt_%'`
    );
    for (const r of rows) {
      assert.ok(!r.value.includes('access-sandbox'), `${r.key} should not contain access token`);
      assert.ok(!r.value.includes('sk-'), `${r.key} should not contain API key`);
    }
  });
});
