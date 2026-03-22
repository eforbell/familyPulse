# Feature #18: Browser Test Foundation

## Problem
Family Pulse now has multiple user-critical pages where regressions show up only in a real browser:
page boot, auth-gated rendering, theme changes, resize behavior, canvas/chart updates, and DOM
interactions such as selectors and history refreshes. `node:test` covers backend logic well, but it
cannot verify that these page-level behaviors still work after frontend changes.

## Solution
Add a minimal browser-based testing foundation focused on reliability rather than breadth:

1. **One browser runner** — Playwright with Chromium only in the first release
2. **Reusable authenticated setup** — helper-backed parent session creation for protected pages
3. **Small initial spec set** — Reports page plus one additional non-chart flow
4. **Behavior-first assertions** — verify DOM state and interactions, not pixel-perfect canvas output

This gives the app a real browser safety net without replacing the existing `node:test` suite or
committing the repo to broad screenshot regression testing.

## Key Decisions
- **Playwright over ad hoc DOM mocking** for first browser coverage
- **Chromium only** to keep setup and runtime manageable
- **Keep `node:test` as the default** for API and business-logic coverage
- **Target high-risk flows only** instead of broad page coverage
- **Avoid screenshot-heavy testing** in the first release

## Candidate Initial Coverage
- Reports page loads for a parent
- Doughnut month selector updates safely
- Theme toggle does not break Reports interactions
- Ask/What-If history refresh remains working
- One additional flow on Budget, Transactions, or Settings

## Files Expected
| File | Change |
|------|--------|
| `planning/features/feature-18-prd.json` | PRD for browser testing foundation |
| `planning/features/feature-18-summary.md` | Feature summary |
| `package.json` | Add browser test scripts |
| `playwright.config.*` | Browser runner configuration |
| `test/e2e/*` | Initial browser specs |
| `test/helpers/*` | Shared auth/session helpers |
| `README.md` | Local run instructions |
