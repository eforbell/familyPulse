-- seed.sql — default categories, family members, app_config

-- ── Family Members ───────────────────────────────────────────

INSERT INTO family_members (name, role, avatar_emoji, color) VALUES
  ('Eric',   'parent', '👨', '#3b82f6'),
  ('Alex',    'parent', '👩', '#ec4899'),
  ('Jordan',   'kid',    '👦', '#f59e0b'),
  ('Casey', 'kid',    '👧', '#8b5cf6')
ON CONFLICT (name) DO NOTHING;

-- ── Categories ───────────────────────────────────────────────

INSERT INTO categories (name, color, is_income, is_transfer_class, icon) VALUES
  ('Groceries',       '#22c55e', false, false, '🛒'),
  ('Dining Out',      '#f97316', false, false, '🍽️'),
  ('Gas & Auto',      '#64748b', false, false, '⛽'),
  ('Utilities',       '#06b6d4', false, false, '💡'),
  ('Healthcare',      '#ef4444', false, false, '🏥'),
  ('Entertainment',   '#a855f7', false, false, '🎬'),
  ('Shopping',        '#ec4899', false, false, '🛍️'),
  ('Kids Activities', '#f59e0b', false, false, '⚽'),
  ('Subscriptions',   '#6366f1', false, false, '📦'),
  ('Home & Garden',   '#84cc16', false, false, '🏡'),
  ('Insurance',       '#78716c', false, false, '🛡️'),
  ('Travel',          '#0ea5e9', false, false, '✈️'),
  ('Income',          '#10b981', true,  false, '💰'),
  ('Transfer',        '#9ca3af', false, true,  '🔄'),
  ('CC Payment',      '#9ca3af', false, true,  '💳'),
  ('529 Contribution','#3b82f6', false, true,  '🎓'),
  ('Crypto/BTC',      '#f59e0b', false, true,  '₿'),
  ('Uncategorized',   '#6b7280', false, false, '❓')
ON CONFLICT (name) DO NOTHING;

-- ── Category Rules ───────────────────────────────────────────

INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by) VALUES
  ('Coinbase',  (SELECT id FROM categories WHERE name = 'Crypto/BTC'), 'contains', 'seed'),
  ('Swan',      (SELECT id FROM categories WHERE name = 'Crypto/BTC'), 'contains', 'seed'),
  ('Strike',    (SELECT id FROM categories WHERE name = 'Crypto/BTC'), 'contains', 'seed'),
  ('529',       (SELECT id FROM categories WHERE name = '529 Contribution'), 'contains', 'seed')
ON CONFLICT DO NOTHING;

-- ── App Config ───────────────────────────────────────────────

INSERT INTO app_config (key, value) VALUES
  ('sync_interval_hours', '12'),
  ('transfer_detection_window_days', '7'),
  ('transfer_amount_tolerance', '1.00'),
  ('transfer_date_tolerance_days', '3'),
  ('accent_color', '#10b981'),
  ('anomaly_threshold_pct', '130'),
  ('anomaly_min_avg_dollars', '25'),
  ('magic_prompt_weekly_digest', 'You are a helpful family finance assistant for the Forbell household (Eric, Alex, Jordan, Casey). Write a brief, friendly weekly spending digest in plain English. Highlight any spending spikes or anomalies. Keep it to 3-5 short paragraphs. Use dollar amounts. Do not include account numbers or sensitive information.'),
  ('magic_prompt_monthly_close', 'You are a family finance assistant for the Forbell household (Eric, Alex, Jordan, Casey). Write a concise monthly close report. Summarize income vs spending, highlight categories that were over or under budget, note wins and areas to watch. Compare to the prior month and 3-month averages. Keep it friendly and actionable, 4-6 paragraphs.'),
  ('magic_prompt_on_demand', 'You are a family finance assistant for the Forbell household (Eric, Alex, Jordan, Casey). Answer the user''s financial question using only the data provided. Be specific with dollar amounts and percentages. If the data is insufficient to answer fully, say so. Do not make up numbers. Keep the response concise and helpful.'),
  ('magic_prompt_what_if', 'You are a family finance planner for the Forbell household (Eric, Alex, Jordan, Casey). Given the household''s current financial snapshot, project the impact of the described scenario over 3, 6, and 12 months. Clearly communicate uncertainty — use ranges rather than exact numbers. Include caveats about assumptions. Be helpful but honest about limitations.'),
  ('magic_rate_limit_daily', '10'),
  ('magic_disclaimer', 'AI-generated analysis — not financial advice.'),
  ('coverage_alert_threshold', '0.70'),
  ('balance_basis', 'available_preferred'),
  ('recurring_amount_tolerance_pct', '10'),
  ('recurring_lookback_months', '18'),
  ('recurring_last_detection_at', '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
