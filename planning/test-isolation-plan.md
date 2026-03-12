# Test Isolation Plan

## Problem
Current tests are a mix of unit and integration tests that run against whatever `DATABASE_URL` points to on the machine. This causes:
- nondeterministic failures from ambient data
- accidental writes against non-test databases
- coupling between test files via shared state

## Goal
Make tests deterministic, isolated, and safe by requiring a dedicated test database and controlled fixture data.

## Non-Goals
- Rewriting all tests to pure unit tests immediately
- Replacing PostgreSQL with mocks for DB integration coverage

## Target State
- `npm test` only runs when `DATABASE_URL` points to an approved test DB (for example `*_test`)
- test DB schema is created/reset in a repeatable way
- baseline fixture data is seeded deterministically
- integration tests use unique per-suite fixture keys and clean up reliably
- no test relies on existing developer machine data

## Implementation Plan

### Phase 1: Safety Guardrails (Immediate)
1. Add a test bootstrap guard (`test/bootstrap.js`) that fails fast if:
   - `NODE_ENV !== 'test'` (or not explicitly set for tests)
   - database name/URL does not match test-safe pattern (for example contains `_test`)
2. Update `package.json` test script to always preload bootstrap.
3. Document required env vars in `README` and `.env.test.example`.

Acceptance criteria:
- running tests against a non-test DB exits with a clear error
- local and CI use the same guardrails

### Phase 2: Deterministic DB Lifecycle
1. Add scripts:
   - `npm run test:db:reset` (drop/recreate schema or database)
   - `npm run test:db:migrate` (apply migrations)
   - `npm run test:db:seed` (insert baseline deterministic fixtures)
2. Add `npm run test:ci` that executes reset -> migrate -> seed -> test.
3. Ensure migrations are idempotent and can be run from a clean DB.

Acceptance criteria:
- two consecutive runs produce identical test outcomes
- tests pass from an empty test DB without manual prep

### Phase 3: Test Data Contract
1. Create `test/fixtures/sql/base_seed.sql` (or JS seed module) for canonical fixture records:
   - family members
   - categories (income/transfer/uncategorized)
   - minimal items/accounts
2. Migrate test files away from querying ambient records like `SELECT id FROM accounts LIMIT 1`.
3. Use explicit fixture IDs/namespaces per suite (prefix with suite token + timestamp/random suffix).

Acceptance criteria:
- no test depends on pre-existing rows
- tests are order-independent

### Phase 4: Integration Test Isolation Improvements
1. For HTTP integration suites, create helper utilities:
   - `createTestSession(member)` to get authenticated cookie
   - `apiRequest()` wrapper that sends cookie automatically
2. Use per-suite setup/teardown helpers in `test/helpers/`.
3. Remove cross-suite leakage (cleanup in each suite, not only global afters).

Acceptance criteria:
- integration tests pass with auth enabled
- suites can run individually or together with same results

### Phase 5: Optional Parallelism Hardening
1. Evaluate parallel-safe strategy:
   - dedicated schema per test worker, or
   - serialized integration suites while unit tests run in parallel
2. Add CI matrix or split jobs (`unit` vs `integration`).

Acceptance criteria:
- predictable runtime
- no flaky failures from concurrent DB mutation

## Required Project Changes
- `package.json` scripts: add `test:ci`, `test:db:*`, and bootstrap preload
- `test/bootstrap.js`: environment and DB safety checks
- `test/helpers/*`: seed/setup/auth helpers
- `test/fixtures/*`: deterministic baseline data
- CI workflow: provision test DB and use `npm run test:ci`

## Proposed Command Contract
- `npm test`: quick local run against already-prepared test DB (guarded)
- `npm run test:ci`: full reset/migrate/seed/test pipeline

## Risks and Mitigations
- Risk: Migration reset is slow.
  - Mitigation: cache DB service in CI job, keep fixtures minimal.
- Risk: Existing tests assume unauthenticated API access.
  - Mitigation: provide shared authenticated test helper and refactor incrementally.
- Risk: Developers forget `.env.test`.
  - Mitigation: bootstrap error message with exact setup steps.

## Initial Task Backlog
1. Add `test/bootstrap.js` DB safety guard.
2. Add `.env.test.example` and docs.
3. Add reset/migrate/seed scripts.
4. Create baseline seed fixtures.
5. Refactor `budget-api`, `categories-api`, `transactions-api`, `link-api` to use shared helpers.
6. Remove ambient-data patterns (`LIMIT 1` lookups, broad aggregate assumptions).

## Definition of Done
- test execution cannot target production/dev DB by accident
- test results are deterministic across machines
- CI runs from clean DB state and is green
- integration tests no longer depend on ambient local data
