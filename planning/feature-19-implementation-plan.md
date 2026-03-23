# Feature 19 Implementation Plan

## Scope
Implement Feature 19 as the recurring cashflow substrate for both in-app visibility and Feature 20 forecast inputs. Delivery order is backend-first so the data model and detector contract settle before UI work.

## Branch
- `feature/recurring-cashflow-intelligence`

## Delivery Strategy

### Slice A: Schema + Detector Core
- Add migration `014-recurring-expenses.sql`
- Add recurring config keys to [db/seed.sql](/Volumes/DATA/workspace/homeApps/familyPulse/db/seed.sql)
- Create [lib/merchant-normalizer.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/merchant-normalizer.js)
- Create [lib/recurring-detector.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/recurring-detector.js)
- Add unit tests for normalization and recurrence classification

Exit criteria:
- recurring tables exist with schedule metadata
- detector can classify recurring income and expense patterns from fixtures
- debt-service and transfer-like flows are excluded from committed expense totals
- tests cover normalization, frequency classification, stale logic, and idempotent upsert behavior

### Slice B: Price History + Calendar + API
- Append latest observations into recurring history table
- Expose recurring list, summary, history, and calendar endpoints
- Add parent-only PATCH override for status/frequency/expected-next-date
- Add API tests for response shapes and auth

Exit criteria:
- recurring endpoints are stable enough for frontend consumption
- bill calendar projections use stored schedule metadata with interval fallback

### Slice C: Sync Integration
- Run detector in [lib/sync.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/sync.js) after transfer detection and auto-categorization, before anomaly detection
- Add incremental rerun path keyed off `recurring_last_detection_at`
- Ensure detector failure is isolated and logged
- Extend sync tests for hook ordering and error isolation

Exit criteria:
- recurring detection runs automatically after sync
- sync still succeeds when detector fails

### Slice D: UI + Budget Integration
- Add recurring page and nav entry
- Add committed/discretionary summary into budget and dashboard surfaces
- Keep mobile nav and More-sheet copy coherent after new nav item

Exit criteria:
- recurring page renders live API data
- budget summary includes committed totals without double-counting liabilities

### Slice E: LLM Context
- Extend context assembler with recurring summary for weekly/monthly/query contexts
- Ensure all new context is sanitized via `sanitizeForLLM`

Exit criteria:
- recurring summary appears in existing LLM contexts with tests

## Codebase Touchpoints
- [db/migrations](/Volumes/DATA/workspace/homeApps/familyPulse/db/migrations)
- [db/seed.sql](/Volumes/DATA/workspace/homeApps/familyPulse/db/seed.sql)
- [lib/sync.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/sync.js)
- [lib/budget-calculator.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/budget-calculator.js)
- [lib/magic-actions/context-assembler.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/magic-actions/context-assembler.js)
- [public/nav.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/nav.js)
- [test/sync.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/sync.test.js)

## Design Constraints
- Treat recurring rows as directional cashflows (`expense` vs `income`)
- Preserve original merchant names for display; normalization is grouping-only
- Exclude transfers, internal account moves, and debt-service flows from committed expense logic
- Keep detection conservative: false negatives are preferable to false positives
- Persist enough schedule metadata for forecast consumers to project future dates deterministically

## Immediate Next Step
Start Slice A with migration design and detector helpers, then lock the core behavior down with `node:test` coverage before wiring sync or UI.
