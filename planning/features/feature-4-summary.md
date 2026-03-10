# Feature 4: Budget Framework

## Purpose

Monthly budget vs. actual spending — the core value proposition. Category cards with color-coded burn rates, income tracking, net cash flow, and rolling 3-month averages for context. This is why Eric is replacing Monarch.

## Why This Is Worth Shipping

Without budget tracking, Family Pulse is just a transaction viewer. This feature answers the daily question: "How are we doing this month?" at a glance.

## Scope

1. Monthly budget targets per spending category (admin-editable)
2. Dashboard with category cards: budgeted / spent / remaining with color coding
3. Income tracking from direct deposit detection
4. Net cash flow: income minus non-transfer spending
5. Rolling 3-month average per category for baseline context
6. Budget period snapshots for historical performance (precomputed)

## Key Design Decisions

- **Precomputed snapshots** — budget_periods table stores monthly rollups for fast dashboard loads
- **Color thresholds** — green (<70%), yellow (70-99%), red (100%+) — simple, scannable
- **Transfer exclusion is non-negotiable** — budget math only counts real expenses
- **Uncategorized spending** gets its own prominent card so nothing hides

## Definition of Done

- Budget targets configurable per category via admin UI
- Dashboard shows all spending categories with budget/spent/remaining and color coding
- Over-budget categories sort to the top
- Income total and net cash flow displayed
- Rolling 3-month averages shown per category
- Monthly snapshots generated automatically and backfilled for imported history
- All budget calculation tests pass with known test data

## Status: COMPLETE (2026-03-10)

### What shipped
- `db/migrations/004-budget-framework.sql` — budget_snapshots table
- `lib/budget-calculator.js` — monthly summary with income, spending, net cash flow, rolling averages
- `lib/snapshot-generator.js` — precomputed monthly snapshots with upsert
- `lib/routes/budget.js` — summary, category detail, snapshot, and backfill endpoints
- `public/budget.html` + `budget.js` — month nav, summary hero, category cards, detail overlay
- `public/transactions.html` + `transactions.js` — standalone transaction browser with URL deep-linking
- Dashboard account cards deep-link to transactions page
- 14 tests across budget-api and budget-calculator suites
- Uncategorized card and category detail overlay link to transactions page with filters pre-set
