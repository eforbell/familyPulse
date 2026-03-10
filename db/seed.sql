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
  ('anomaly_min_avg_dollars', '25')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
