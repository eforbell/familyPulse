-- 010: Add monthly budget column for kid-role family members
ALTER TABLE family_members
  ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC(10,2);
