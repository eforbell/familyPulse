# Feature #17: Visual Reports

## Problem
The Reports page shows LLM-generated text reports (monthly close, weekly digest) that produce
dense multi-paragraph analyses. These are hard to scan and not useful for quickly understanding
spending patterns. A bar chart communicates "spending was 82% of income in January" faster than
three sentences of prose.

## Solution
Replace the report history accordion with three interactive Chart.js visualizations:

1. **Income vs Spending** — Bar chart with income and spending per month, net cash flow line overlay
2. **Spending by Category** — Doughnut chart for a selected month, using category colors from DB
3. **Category Trends** — Line chart showing top 5 categories month-over-month

A new `GET /api/budget/trends` endpoint returns 6 months of aggregated data in a single call,
powered by the existing `budget_snapshots` table.

Ask Pulse and What-If remain below the charts for interactive queries.

## Key Decisions
- **Single endpoint** for all chart data (2-3 SQL queries vs 30 if calling existing endpoint 6x)
- **Top 5 categories** for trend lines to keep the chart readable
- **Month selector dropdown** for doughnut chart rather than clicking bars
- **Chart.js 4.x** already in use on kids dashboard — no new dependencies
- **Fresh snapshot** generated for current month to ensure live data
- **Repo-native testing only** for now — stay on `node:test`; do not introduce Playwright or a DOM harness just for this feature

## Files Changed
| File | Change |
|------|--------|
| `lib/budget-calculator.js` | Add `getBudgetTrends(months)` |
| `lib/routes/budget.js` | Add `GET /api/budget/trends` route |
| `public/reports.html` | Add Chart.js, replace accordion with 3 canvases |
| `public/reports.js` | Chart rendering, remove LLM report rendering |
| `public/style.css` | Chart card and month selector styles |

## Test Plan

### Automated now
- `node:test` integration coverage for `GET /api/budget/trends`:
  - default 6-month response shape
  - parent-only access control
  - month bound clamping
  - on-demand generation of missing snapshots
  - refresh of the current-month snapshot
- Existing API coverage for Ask/What-If history remains the safety net for the lower half of the page

### Recommended next refactor for better automation
- Extract pure helpers from `public/reports.js` for:
  - income vs spending dataset construction
  - doughnut top-8 plus `Other` grouping
  - top-5 category trend selection
- Add `node:test` unit coverage for those helpers with seeded input objects
- Avoid trying to unit test Chart.js canvas output directly

### Manual checks still required
- Load `reports.html` as a parent and confirm all three charts render
- Switch doughnut month selector across populated and empty months, then back again
- Toggle light/dark theme and verify chart legends, axes, and grid lines update without reload
- Submit Ask Pulse and What-If prompts and confirm history refreshes immediately
- Verify mobile layout does not overflow and chart cards stack cleanly
