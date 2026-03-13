# Feature 12: Credit Card Liability Coverage

## Purpose

Surface Plaid's liability data (statement balances, due dates, minimum payments, APRs, overdue status) and calculate whether checking account balances can cover upcoming credit card statement obligations.

## Why This Matters

The Forbells pay statement balances in full every month. The key question is cashflow coverage: can checking accounts cover upcoming credit card statements, especially when due dates are staggered? Monarch doesn't surface any of this. We will.

## Scope

### Phase 1: Schema + Sync
- Migration adds 8 liability columns to `accounts` table
- Sync extended to store all Plaid liability fields (not just `last_statement_balance`)
- `coverage_alert_threshold` added to `app_config` (default 0.70)

### Phase 2: Coverage Calculator + API
- Pure calculation module: checking balance vs statement obligations
- Status tiers: `clear` | `healthy` | `warning` (>=70% consumed) | `danger` (obligations > checking)
- New `GET /api/accounts/coverage` endpoint
- Existing account queries extended with liability columns

### Phase 3: Frontend
- **Accounts page**: Coverage banner between net-position and account grid, per-card breakdown with due dates. Credit card account cards show statement balance, due date, minimum payment.
- **Dashboard**: Compact single-line coverage indicator linking to accounts page.
- **Budget page**: Obligations card showing statement total and coverage ratio.

### Phase 4: LLM Context Enrichment
- All four context assemblers (weekly, monthly, query, snapshot) include `liability_coverage` block
- Financial snapshot gains `checking_balance`, `statement_obligations`, `coverage_ratio`
- Credit account objects enriched with `statement_balance` and `due_date`

### Phase 5: Tests
- `test/coverage-calculator.test.js` — healthy/warning/danger/clear scenarios, due-date ordering, statement fallback
- `test/sync.test.js` extended — liability field persistence verification

## Key Design Decisions

- **Coverage base: checking only** — needing savings to cover cards is "crazy town"
- **Obligation = statement balance** — falls back to `current_balance` if no statement data
- **All liability fields nullable** — gracefully handles sparse Plaid responses
- **Configurable threshold** — `coverage_alert_threshold` in `app_config` (default 70%)

## Definition of Done

- Migration applied, liability columns exist on accounts
- Sync populates all liability fields for credit accounts
- Coverage API returns correct analysis
- Three pages surface coverage data
- LLM context includes liability/coverage information
- All tests pass
