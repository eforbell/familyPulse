-- Persist paycheck facts separately from their accounting allocations so a
-- prior paystub can seed the next imported deposit.

ALTER TABLE categories ADD COLUMN IF NOT EXISTS system_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_categories_system_key
  ON categories(system_key) WHERE system_key IS NOT NULL;

-- System keys carry payroll semantics; display names remain human-readable.
-- If a household already owns one of these names, choose a deterministic
-- suffixed name rather than commandeering and reclassifying their category.
DO $$
DECLARE
  definition RECORD;
  candidate_name TEXT;
  suffix INT;
BEGIN
  FOR definition IN
    SELECT * FROM (VALUES
      ('paycheck.gross_earnings',      'Gross Pay',                  '#10b981', true,  '💰'),
      ('paycheck.federal_tax',         'Federal Income Tax',         '#ef4444', false, '🏛️'),
      ('paycheck.social_security_tax', 'Social Security Tax',        '#f97316', false, '🇺🇸'),
      ('paycheck.medicare_tax',        'Medicare Tax',               '#fb7185', false, '🩺'),
      ('paycheck.retirement_401k',     '401(k) Contributions',       '#8b5cf6', false, '🌱'),
      ('paycheck.health_insurance',    'Health Insurance Premiums', '#06b6d4', false, '🩺'),
      ('paycheck.other_deductions',    'Other Payroll Deductions',   '#64748b', false, '🧾')
    ) AS definitions(system_key, category_name, color, is_income, icon)
  LOOP
    IF EXISTS (SELECT 1 FROM categories WHERE system_key = definition.system_key) THEN
      UPDATE categories
      SET is_income = definition.is_income,
          is_transfer_class = false,
          exclude_from_learning = true,
          exclude_from_baseline = true
      WHERE system_key = definition.system_key;
      CONTINUE;
    END IF;

    candidate_name := definition.category_name;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM categories WHERE name = candidate_name) LOOP
      suffix := suffix + 1;
      candidate_name := format('%s (Payroll %s)', definition.category_name, suffix);
    END LOOP;

    INSERT INTO categories (
      name, color, is_income, is_transfer_class, icon,
      exclude_from_learning, exclude_from_baseline, system_key
    ) VALUES (
      candidate_name, definition.color, definition.is_income, false, definition.icon,
      true, true, definition.system_key
    );
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS paycheck_category_mappings (
  field_key   TEXT PRIMARY KEY CHECK (field_key IN (
    'gross_earnings', 'federal_tax', 'social_security_tax', 'medicare_tax',
    'retirement_401k', 'health_insurance', 'other_deductions'
  )),
  category_id INT NOT NULL UNIQUE REFERENCES categories(id) ON DELETE RESTRICT
);

INSERT INTO paycheck_category_mappings (field_key, category_id)
SELECT mapping.field_key, c.id
FROM (VALUES
  ('gross_earnings', 'paycheck.gross_earnings'),
  ('federal_tax', 'paycheck.federal_tax'),
  ('social_security_tax', 'paycheck.social_security_tax'),
  ('medicare_tax', 'paycheck.medicare_tax'),
  ('retirement_401k', 'paycheck.retirement_401k'),
  ('health_insurance', 'paycheck.health_insurance'),
  ('other_deductions', 'paycheck.other_deductions')
) AS mapping(field_key, system_key)
JOIN categories c ON c.system_key = mapping.system_key
ON CONFLICT (field_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS paychecks (
  id                  SERIAL PRIMARY KEY,
  transaction_id      INT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  member_id           INT NOT NULL REFERENCES family_members(id) ON DELETE RESTRICT,
  employer            TEXT NOT NULL CHECK (char_length(trim(employer)) BETWEEN 1 AND 160),
  gross_earnings      NUMERIC(12,2) NOT NULL CHECK (gross_earnings > 0),
  federal_tax         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (federal_tax >= 0),
  social_security_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (social_security_tax >= 0),
  medicare_tax        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (medicare_tax >= 0),
  retirement_401k     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (retirement_401k >= 0),
  health_insurance    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (health_insurance >= 0),
  other_deductions    JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(other_deductions) = 'array'),
  source_net_amount   NUMERIC(12,2) NOT NULL CHECK (source_net_amount > 0),
  reconciliation_status TEXT NOT NULL DEFAULT 'matched'
    CHECK (reconciliation_status IN ('matched', 'source_changed')),
  created_by          INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paychecks_member_employer_recent
  ON paychecks(member_id, lower(employer), updated_at DESC, id DESC);

COMMENT ON TABLE paychecks IS
  'User-entered gross pay and deduction facts for an imported net-pay transaction; recent rows are reusable templates.';

CREATE OR REPLACE FUNCTION mark_paycheck_source_revision()
RETURNS trigger AS $$
DECLARE
  next_status TEXT;
BEGIN
  next_status := CASE
    WHEN NEW.amount = -(SELECT source_net_amount FROM paychecks WHERE transaction_id = NEW.id)
      THEN 'matched'
    ELSE 'source_changed'
  END;
  UPDATE paychecks
  SET reconciliation_status = next_status,
      updated_at = now()
  WHERE transaction_id = NEW.id
    AND reconciliation_status IS DISTINCT FROM next_status;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_paycheck_source_revision ON transactions;
CREATE TRIGGER trg_mark_paycheck_source_revision
AFTER UPDATE OF amount ON transactions
FOR EACH ROW
WHEN (NEW.amount IS DISTINCT FROM OLD.amount)
EXECUTE FUNCTION mark_paycheck_source_revision();
