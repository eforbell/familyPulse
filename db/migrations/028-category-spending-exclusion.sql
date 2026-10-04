-- 028-category-spending-exclusion.sql — keep money that never reached the bank
-- out of spending reports.
--
-- Payroll deduction lines (taxes, 401(k), premiums) are real outflows of gross
-- pay and belong in the cash flow Sankey, but counting them as household
-- spending inflates the category doughnut, Category Trends and Budget cards.
-- The flag is a reporting preference only: cash flow views ignore it.

ALTER TABLE categories
ADD COLUMN IF NOT EXISTS exclude_from_spending BOOLEAN NOT NULL DEFAULT false;

-- Default payroll deductions to excluded. Gross pay is income and never counts
-- as spending anyway. Runs once, so a later opt-back-in is never overwritten.
UPDATE categories
SET exclude_from_spending = true
WHERE system_key LIKE 'paycheck.%'
  AND system_key <> 'paycheck.gross_earnings';
