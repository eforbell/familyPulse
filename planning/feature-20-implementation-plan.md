# Feature 20 Implementation Plan

## Scope
Deterministic 90-day cash flow forecasting engine. Synthesizes Feature 19 recurring cashflows, Plaid liability obligations, seasonal discretionary spending patterns, and manually planned one-time expenses into a day-by-day balance projection with danger zone detection, excess-liquidity guidance, and scenario toggling.

## Branch
- `feature/predictive-cash-flow`

## Pre-flight Status
- Feature 19 is shipped and running in production — 20 active recurring patterns, $3,477 committed monthly, $8,068 recurring income
- 4–5 months of transaction history available (short of the 12-month ideal for seasonal baseline — engine must handle sparse data gracefully)
- Liability data present for some credit cards; Chase mortgage is tracked via recurring detection, not Plaid liabilities
- `balance-policy.js` `sumAccountBalances()` is ready to provide starting balance
- `coverage-calculator.js` has the liability query pattern — `minimum_payment_amount` and `next_payment_due_date` from the `accounts` table
- `recurring-detector.js` exports `computeExpectedNextDate`, `addDays`, `addMonths`, `monthlyEquivalent` — all reusable for schedule projection
- Chart.js 4.x CDN pattern established in `reports.html` and `kids.html`

## Delivery Strategy

### Slice A: Schema + Seasonal Baseline + Core Forecast Engine
**Stories: FCF-020-001, FCF-020-002**

- Create migration `015-cash-flow-forecast.sql`:
  - `planned_expenses` table (id, name, amount, scheduled_date, status, notes, created_by, created_at, updated_at)
  - `cash_flow_snapshots` table (id, computed_at, horizon_days, starting_balance, input_fingerprint, daily_projections JSONB, danger_zones JSONB, monthly_outlook JSONB, excess_liquidity JSONB)
- Add new config keys to `db/seed.sql`:
  - `cash_flow_safety_floor` (default `3000`)
  - `cash_flow_horizon_days` (default `90`)
  - `cash_reserve_target_months` (default `3.0`)
- Create `lib/seasonal-baseline.js`:
  - Queries transaction history by calendar month
  - Excludes: transfers, income, hidden, pending, and transactions linked to active recurring items (by merchant key match)
  - Uses median per calendar month (not mean) to resist outlier skew
  - Handles sparse months (<12 months of data) with overall average fallback
  - Excludes current incomplete month
  - Output: array of `{ month: 1-12, median_discretionary, sample_months }`
- Create `lib/cash-flow-engine.js` — **pure function, no side effects, no DB calls**:
  - Inputs: `{ starting_balance, recurring_income[], recurring_expenses[], liability_payments[], seasonal_baseline[], planned_expenses[], horizon_days, safety_floor }`
  - Output: `{ daily_projections[], danger_zones[], monthly_outlook[], excess_liquidity }`
  - Recurring items projected using `computeExpectedNextDate` from Feature 19 in a loop across the horizon
  - Liability payments scheduled on `next_payment_due_date`, then monthly recurrence inferred
  - Discretionary daily burn = `seasonal_discretionary[month] / days_in_month`
  - Confidence bands: ±5% at 7 days, ±15% at 30 days, ±25% at 90 days (linear interpolation between)
  - Events array on each day: what income/expense/liability/planned item hit

Exit criteria:
- Engine produces deterministic output from fixture inputs
- Same inputs always produce same output (pure function test)
- Seasonal baseline handles 4-month, 12-month, and 18-month data windows correctly
- Tests: simple case (1 income + 1 expense, 30 days), complex case (full household), edge cases (month boundary, short month, last-day-of-month anchors)

### Slice B: Danger Zones + Monthly Outlook + Excess Liquidity
**Stories: FCF-020-003, FCF-020-004, FCF-020-004A**

- Danger zone scanner walks the daily projection array:
  - `danger` when projected balance < safety floor
  - `at_risk` when only confidence_low < safety floor but projected balance is above
  - Multiple zones possible (balance recovers then drops)
  - Output: `{ date, projected_balance, deficit_below_floor, trigger_event, severity }`
- Monthly outlook aggregates daily projections into next 3 months:
  - `{ month, expected_income, expected_recurring, expected_discretionary, expected_liability_payments, planned_expenses_total, net_surplus_or_deficit, projected_end_balance }`
  - Chained: end-of-month balance carries forward as next month's start
- Excess liquidity detection:
  - Reserve target = `max(safety_floor, committed_monthly_total × cash_reserve_target_months)`
  - If 90-day projected minimum balance > reserve target, compute excess amount
  - Recommendation levels: `none`, `modest` (excess < 1× committed monthly), `strong` (excess ≥ 1× committed monthly)

Exit criteria:
- Danger zone correctly flags single and multiple crossings, distinguishes danger from at_risk
- Monthly outlook chains correctly across 3 months
- Excess liquidity: no recommendation when tight, modest/strong when flush
- All computation is part of the pure engine function (no new DB queries)

### Slice C: Planned Expenses CRUD + API Endpoints + Forecast Cache
**Stories: FCF-020-005, FCF-020-006**

- Create `lib/routes/cash-flow.js`:
  - `GET /api/cash-flow/forecast` — returns cached forecast or recomputes if stale
  - `GET /api/cash-flow/monthly-outlook` — extracted from forecast
  - `GET /api/cash-flow/danger-zones` — extracted from forecast
  - `POST /api/cash-flow/planned-expenses` — create (parent-only)
  - `GET /api/cash-flow/planned-expenses` — list active
  - `PATCH /api/cash-flow/planned-expenses/:id` — update (parent-only)
  - `DELETE /api/cash-flow/planned-expenses/:id` — soft delete (parent-only)
  - `POST /api/cash-flow/forecast/refresh` — force recompute (parent-only)
- Forecast assembly function (not pure — this one reads DB):
  - Fetches starting balance via `sumAccountBalances` for depository accounts
  - Fetches active recurring items from `recurring_expenses`
  - Fetches liability payment schedules from `accounts` (credit + loan)
  - Fetches seasonal baseline
  - Fetches planned expenses
  - Passes all to the pure engine, caches result in `cash_flow_snapshots`
- Cache staleness: fingerprint from `max(import_runs.finished_at)`, `max(recurring_expenses.updated_at)`, `max(planned_expenses.updated_at)`, config values
- Wire `lib/routes/cash-flow.js` into `server.js`
- Add forecast refresh to `lib/sync.js` (after recurring detection, before anomaly detection)

Exit criteria:
- All API endpoints return correct shapes and respect auth guards
- Planned expense validation works (name required, amount > 0, date validation)
- Cache hit returns stored data; cache miss triggers recomputation
- Force refresh replaces cache
- Sync triggers forecast refresh with error isolation

### Slice D: Frontend — Forecast Page
**Story: FCF-020-007**

- Create `public/forecast.html` and `public/forecast.js`
- Load Chart.js + chartjs-plugin-annotation from CDN
- Hero section: current liquid balance, 90-day outlook status badge, next danger zone
- Balance trajectory chart:
  - Line: projected balance
  - Filled area: confidence bands
  - Dashed horizontal: safety floor
  - Red highlighted regions: danger zones
  - Tooltips: date, balance, events
- Monthly outlook cards: 3 cards with income/outflow/net/end-balance, color-coded
- Excess liquidity section: when opportunity exists, show recommendation
- Planned expenses section:
  - List with add form (name, amount, date)
  - Toggle switch per item for scenario modeling
  - Toggle immediately re-fetches forecast and re-renders chart
- Forecast assumptions: expandable section listing detected income, recurring expenses, liability payments, discretionary baseline, reserve target
- Loading state, empty state (link to Recurring page if no data)
- Add nav entry after Recurring, add 'Forecast' to More sheet copy
- Add `recurring.html` to `HTML_PAGES` set in `server.js`
- Responsive: chart fills width on mobile, cards stack
- Theme-aware via CSS variables, re-render chart on theme change
- Playwright e2e tests: page loads, chart renders, monthly cards visible, planned expense add/toggle

Exit criteria:
- Forecast page renders with live data from API
- Chart shows trajectory with confidence bands and safety floor
- Planned expense toggle immediately updates chart
- Mobile layout is usable
- Playwright tests cover page load, rendering, and planned expense interaction

### Slice E: Dashboard Widget + LLM Context + What-If Enhancement
**Stories: FCF-020-008, FCF-020-009, FCF-020-010**

- Dashboard forecast widget (`public/index.html` + `public/app.js`):
  - 2–3 line forecast summary below recurring indicator
  - Shows: outlook status badge, next danger zone or excess liquidity summary
  - Clicks through to forecast.html
  - Muted placeholder if no forecast data
- LLM context enrichment (`lib/magic-actions/context-assembler.js`):
  - Add forecast summary to weekly, monthly, query, and snapshot contexts
  - Fields: `90_day_outlook_status`, `next_danger_zone`, `monthly_outlook`, `excess_liquidity_opportunity`, `planned_expenses_total`, `projected_90_day_balance`
  - All passes through `sanitizeForLLM`
- What-if enhancement (`lib/magic-actions/what-if.js`):
  - When scenario is submitted, compute baseline forecast
  - If scenario can be parsed into a planned expense equivalent, compute modified forecast
  - Include both baseline and modified trajectories in LLM prompt
  - Fallback to current LLM-only approach if scenario is too abstract
  - Priority 3 — implement only if engine is trusted after Slice D deployment

Exit criteria:
- Dashboard widget renders with forecast summary
- LLM contexts include forecast data and pass sanitization
- What-if prompt has structured forecast baseline (stretch)

## Codebase Touchpoints
- `db/migrations/` — new migration 015
- `db/seed.sql` — 3 new config keys
- `lib/seasonal-baseline.js` — new
- `lib/cash-flow-engine.js` — new (pure function)
- `lib/routes/cash-flow.js` — new
- `lib/sync.js` — add forecast refresh hook
- `lib/balance-policy.js` — consumed, not modified
- `lib/coverage-calculator.js` — query pattern reused, not modified
- `lib/recurring-detector.js` — reuse `computeExpectedNextDate`, `addDays`, `addMonths`, `monthlyEquivalent`
- `lib/magic-actions/context-assembler.js` — extend
- `lib/magic-actions/what-if.js` — extend (stretch)
- `server.js` — wire routes, add to HTML_PAGES
- `public/nav.js` — add Forecast entry
- `public/forecast.html`, `public/forecast.js` — new
- `public/index.html`, `public/app.js` — dashboard widget
- `public/style.css` — forecast page styles

## Design Constraints
- Engine is a **pure function** — all inputs pre-fetched, no DB calls during computation. This makes it testable with fixture data and ensures <500ms execution.
- **No double-counting** — liability payments come from Plaid data; recurring detection excludes debt-service transactions. The engine must not add both.
- **Sparse data handling** — with only 4–5 months of history, seasonal baseline must degrade gracefully (use overall average, wider confidence bands, document assumptions).
- Recurring items that Eric has manually `paused` or `ignored` in Feature 19 must be excluded from forecast inputs. Only `active` status with confidence ≥ `medium` feeds the engine.
- Confidence bands are heuristic, not statistical — label as "estimated range" in UI.
- Planned expenses are intentionally simple: name, amount, date. No recurrence, no categories, no complex modeling.

## Immediate Next Step
Start Slice A: write migration 015, build the seasonal baseline module, then build the core engine as a pure function with comprehensive fixture-based tests. Lock down deterministic behavior before wiring any API or UI.
