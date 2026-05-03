# Feature #20: Predictive Cash Flow Engine

## Problem
Family Pulse looks backward. The dashboard shows current balances. The budget tracks this month's
spending. The coverage calculator checks whether today's deposits cover today's obligations. But
nobody in the household can answer the most fundamental financial question: **"What does our cash
position look like 30, 60, or 90 days from now?"**

The What-If tool (Feature 7) can answer specific hypothetical questions when prompted, but it's
reactive — Eric has to think of the question first. There's no persistent, always-visible forecast
that says "here's where your money is going, and here's the date you should worry about."

Feature 9 (Planning & Goals) was deferred because it needed forward-looking intelligence that
didn't exist yet. This feature provides it.

## Solution
A predictive engine that synthesizes everything Family Pulse already knows into a 90-day
rolling cash flow forecast:

### Inputs (all already available after Feature 19)
- **Current liquid balance** — checking + savings via balance-policy.js
- **Recurring cashflows** — detected recurring income and recurring expenses from Feature 19
- **Liability obligations** — statement balances, due dates, minimums from Plaid Liabilities
- **Seasonal patterns** — 12-month historical spending averages by month (from Monarch + Plaid)
- **Planned one-time expenses** — manually entered by Eric (e.g., "Alex's trip: $6,000 in Oct")

### Outputs
1. **Balance trajectory chart** — line chart showing projected checking+savings balance for
   each day of the next 90 days, with confidence bands
2. **Danger zone detection** — if projected balance crosses below a configurable safety floor,
   flag the exact date and deficit amount
3. **Monthly surplus/deficit cards** — for each of the next 3 months: expected income,
   expected outflow, projected net, and end-of-month balance
4. **Excess liquidity guidance** — if the projected minimum balance stays well above the
   household reserve target, show how much cash could be moved productively without putting
   near-term obligations at risk
5. **Planned expense manager** — simple UI to add/remove one-time future expenses that overlay
   onto the forecast
6. **Scenario toggles** — turn planned expenses on/off to see their impact on the trajectory

### How It Computes
The forecast engine builds a day-by-day ledger:
- Start: today's liquid balance (from balance-policy)
- Each day: add any expected income, subtract any expected recurring charges or liability
  payments scheduled for that date
- Discretionary spending is estimated as a daily burn rate derived from the seasonal
  historical discretionary average for that calendar month, already excluding recurring
  cashflows from the baseline
- Planned one-time expenses are subtracted on their scheduled date
- Reserve target is computed from the safety floor and a configurable number of months of
  committed recurring expenses
- If the projected minimum balance over the full 90-day horizon stays meaningfully above that
  reserve target, the engine emits an excess-liquidity opportunity estimate
- Confidence bands widen over time: ±5% at 7 days, ±15% at 30 days, ±25% at 90 days
  (or can be deferred in v1 if the heuristic is not yet trusted)

### Integration with Feature 9 (Planning & Goals)
This feature provides the forward-looking engine that Feature 9 needs. After Feature 20 ships:
- The **savings signal** (Tight/Comfortable/Splurge Ready) can be computed from the 90-day
  minimum projected balance vs. monthly committed obligations
- **Named goals** can show projected achievement dates by extending the forecast
- **What-If** gains structured forecast data instead of relying solely on LLM narrative

## Key Decisions
- **Computational forecast, not LLM forecast** — the day-by-day projection is deterministic
  math. LLM is used only for narrative interpretation of the results, not for the projection
  itself. This makes forecasts reproducible, testable, and instant.
- **Feature 19 is a hard dependency** — recurring income and expense detection provides the
  structured input that makes the forecast meaningful. Without it, the engine would have to
  guess at recurring charges.
- **Planned expenses are simple** — name, amount, date. No complex modeling in v1.
  Eric enters "Alex's Pacific Rim trip, $6,000, October 2026" and sees its impact.
- **Confidence bands over point estimates** — a single projected line implies false precision.
  Bands communicate "we're pretty sure about next week, less sure about next month."
- **Daily granularity, not hourly** — charges post daily; intra-day precision is noise.
- **Safety floor is configurable** — default $3,000 (app_config), since that's roughly
  1× monthly committed obligations for your household.
- **Good-state guidance matters too** — the forecast should not only warn about shortfalls;
  it should also say when idle cash appears safely above the household reserve target.
- **No liability double-counting** — liability minimum payments come from Plaid liability data;
  matching recurring debt-service transactions are excluded from forecast expense inputs

## New Database Objects
| Object | Purpose |
|--------|---------|
| `planned_expenses` table | Manually entered one-time or recurring future expenses |
| `cash_flow_snapshots` table | Cached forecast results (recomputed after each sync) |
| Migration 015 | Schema for both tables |

## Files Changed
| File | Change |
|------|--------|
| `db/migrations/015-cash-flow-forecast.sql` | New tables |
| `lib/cash-flow-engine.js` | Core forecast computation engine |
| `lib/seasonal-baseline.js` | Historical spending patterns by calendar month |
| `lib/routes/cash-flow.js` | API endpoints |
| `server.js` | Route wiring and refresh trigger registration |
| `lib/sync.js` | Post-sync forecast refresh |
| `public/forecast.html` | Cash flow forecast page |
| `public/forecast.js` | Frontend — trajectory chart, planned expenses, scenario toggles |
| `public/style.css` | Forecast page styles |
| `public/nav.js` | Add nav entry |
| `public/index.html` | Dashboard forecast summary widget |
| `lib/magic-actions/context-assembler.js` | Add forecast context for LLM prompts |
| `lib/magic-actions/what-if.js` | Enhance with structured forecast data |
| `db/seed.sql` | Default config values |

## Test Plan

### Automated now
- Forecast engine: known inputs → deterministic daily balance output
- Income injection: paychecks land on detected frequency dates
- Expense subtraction: recurring charges deducted on expected dates
- Liability payments: due dates from Plaid data correctly scheduled
- Seasonal baseline: historical averages computed correctly per calendar month
- Discretionary estimation: seasonal discretionary baseline = daily discretionary burn
- Planned expense impact: one-time charge reduces balance on scheduled date
- Danger zone detection: flags correct date when balance crosses safety floor
- Excess-liquidity detection: flags when projected minimum balance stays materially above reserve target
- Confidence bands: width increases proportionally over forecast horizon
- Monthly summary cards: income/outflow/net/end-balance computed correctly
- API endpoint response shapes and auth guards
- Planned expense CRUD: create, list, update, delete with validation
- Forecast cache: invalidated after sync, recomputed on next request

### Manual checks
- Load forecast.html and verify trajectory chart looks reasonable against known income/expenses
- Add a planned expense and verify the chart updates with the impact
- Toggle a planned expense off and verify the trajectory recovers
- Check danger zone alert appears when a large planned expense would deplete balance
- Check that a healthy forecast surfaces a reasonable excess-cash recommendation instead of only a neutral/healthy status
- Verify monthly summary cards align with mental model of upcoming months
- Mobile layout: chart remains usable, planned expenses list is scrollable
- Dashboard widget shows a concise forecast summary
