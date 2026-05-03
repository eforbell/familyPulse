# Feature 12: Liability Coverage

## Purpose

Surface Plaid's liability data (statement balances, due dates, minimum payments, APRs, overdue status) for credit cards, mortgages, and student loans, then calculate whether depository account balances can cover upcoming obligations.

## Why This Matters

Household pays statement balances in full every month. The key question is cashflow coverage: can liquid cash cover upcoming obligations across all liability types — credit card statements, mortgage payments, and loan minimums — especially when due dates are staggered? Monarch doesn't surface any of this. We will.

## Scope

### Phase 1: Schema + Sync
- Migration adds 8 liability columns to `accounts` table
- Sync extended to store liability fields for credit cards, mortgages, and student loans
- `coverage_alert_threshold` added to `app_config` via migration (default 0.70)

### Phase 2: Coverage Calculator + API
- Pure calculation module: depository balance vs liability obligations
- Obligations sourced from all liability account types (`credit` + `loan`)
- For credit cards: obligation = statement balance (falls back to current balance)
- For mortgages/loans: obligation = next monthly payment / minimum payment
- Status tiers: `clear` | `healthy` | `warning` (>=70% consumed) | `danger` (obligations > cash)
- New `GET /api/accounts/coverage` endpoint
- Existing account queries extended with liability columns

### Phase 3: Frontend
- **Accounts page**: Coverage banner between net-position and account grid, per-obligation breakdown with due dates. Credit/loan account cards show statement balance, due date, minimum payment.
- **Dashboard**: Compact single-line coverage indicator linking to accounts page.
- **Budget page**: Obligations card showing total and coverage ratio.

### Phase 4: LLM Context Enrichment
- All four context assemblers (weekly, monthly, query, snapshot) include `liability_coverage` block
- Financial snapshot gains `statement_obligations` and `coverage_ratio`
- Liability account objects enriched with `statement_balance` and `due_date`

### Phase 5: Tests
- `test/coverage-calculator.test.js` — healthy/warning/danger/clear scenarios, due-date ordering, statement fallback
- `test/sync.test.js` extended — liability field persistence verification

## Key Design Decisions

- **Coverage base: all depository accounts** — checking, savings, money market, CD (all liquid cash)
- **Obligation sources: credit + loan accounts** — credit cards, mortgages, student loans
- **Obligation mapping**: credit cards use statement balance, mortgages use `next_monthly_payment`, student loans use `minimum_payment_amount`
- **All liability fields nullable** — gracefully handles sparse Plaid responses
- **Configurable threshold** — `coverage_alert_threshold` in `app_config` (default 70%)

## Definition of Done

- Migration applied, liability columns exist on accounts
- Sync populates liability fields for credit cards, mortgages, and student loans
- Coverage API returns correct analysis across all liability types
- Three pages surface coverage data
- LLM context includes liability/coverage information
- All tests pass
