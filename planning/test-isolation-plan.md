# Test Isolation Plan

## Why This Needs To Happen Now
Tests currently run against whatever local database `DATABASE_URL` happens to reference on a given machine. That is already causing failures when switching between the mobile dev machine and the home workstation. It is also an unacceptable risk before connecting production Plaid accounts, because an incorrectly configured test run could mutate or depend on real financial data.

This work is a release-blocking safety and reliability task.

## Problem Statement
Current tests mix unit and integration behavior with weak isolation:
- tests load the default environment opportunistically
- integration tests write to shared database state
- some assertions depend on ambient seed data already existing
- suites are not reliably order-independent
- local test behavior differs across machines depending on database contents

## Goals
- make test runs deterministic across both dev machines and CI
- make it impossible, or at least very hard, to run tests against a non-test database
- ensure integration tests start from a known schema and known baseline fixtures
- remove reliance on ambient developer data
- preserve real PostgreSQL integration coverage

## Non-Goals
- rewriting all DB tests into pure unit tests
- replacing PostgreSQL with mocks for behavior that should be covered end-to-end
- building full parallel-per-worker DB isolation in the first pass

## Required Operating Model

### Source of Truth
- tests must load `.env.test` explicitly
- tests must not inherit database settings from `.env` by default
- `DATABASE_URL` must point to a dedicated test database

### Command Contract
- `npm test`: deterministic local run against a prepared safe test DB; this command performs guard + reset + migrate + seed + test
- `npm run test:fast`: optional developer shortcut that skips reset/seed, but still enforces the test DB guard
- `npm run test:ci`: same deterministic pipeline used in CI

### Safety Rule
- any test command must fail fast if the resolved database target does not clearly look like a test database
- no manual override for this guard in normal workflows

## Target State
- both dev machines can run the same test command and get the same result
- test execution never points at a dev or prod DB by accident
- integration suites pass from an empty test database
- auth-enabled API tests are supported through shared helpers
- test data ownership is explicit: fixed baseline fixtures plus suite-owned ephemeral fixtures

## Implementation Plan

### Phase 1: Hard Safety Guard
Deliverable: tests refuse to run against unsafe databases on any machine.

Tasks:
1. Add `test/bootstrap.js` and preload it for every test invocation.
2. In `test/bootstrap.js`:
   - load `.env.test` explicitly
   - set `NODE_ENV=test` if not already set
   - resolve the effective `DATABASE_URL`
   - reject URLs that do not match a test-safe rule
3. Adopt a strict DB naming contract:
   - examples: `family_pulse_test`, `familypulse_test`, or a URL containing `_test`
   - document the exact accepted patterns so there is no ambiguity
4. Update `package.json` so all test scripts preload the bootstrap.
5. Add `.env.test.example` with only safe test values.
6. Update `README` with a short “local test setup” section for both machines.

Acceptance criteria:
- running tests with only `.env` configured fails
- running tests with a non-test DB URL fails with a clear message
- both machines can use the same `.env.test` pattern

### Phase 2: Deterministic Database Lifecycle
Deliverable: one command creates a known-good database state before tests run.

Tasks:
1. Add explicit scripts:
   - `test:db:reset`
   - `test:db:migrate`
   - `test:db:seed`
2. Decide reset strategy now, not later:
   - preferred first pass: recreate the public schema inside an existing test DB
   - avoid drop/create database if that complicates local permissions
3. Make migrations runnable from a clean database without manual intervention.
4. Create `test:prepare` that runs reset -> migrate -> seed.
5. Make `npm test` and `npm run test:ci` call `test:prepare` before the test runner.

Acceptance criteria:
- two consecutive `npm test` runs yield identical results
- tests pass on a freshly created empty test DB
- machine A and machine B use the same preparation flow

### Phase 3: Define the Fixture Model
Deliverable: tests no longer depend on ambient rows or ad hoc lookup patterns.

Tasks:
1. Add deterministic baseline fixtures under `test/fixtures/`.
2. Split fixture data into two classes:
   - reference fixtures: fixed IDs and stable semantic meaning
   - suite-owned fixtures: created by helper factories with unique namespace prefixes
3. Baseline reference fixtures should include:
   - family members
   - core categories
   - minimal config required for auth and routing expectations
4. Stop using broad assumptions such as:
   - “some category has transactions”
   - “the first category is good enough”
   - “length is at least 4 because seed data exists”
5. Refactor tests to target named fixtures or factory-created rows instead.

Acceptance criteria:
- no test depends on rows not created by test preparation or suite setup
- no test relies on `LIMIT 1`-style ambient lookups
- tests remain readable because shared reference fixtures have stable names/IDs

### Phase 4: Shared Integration Test Helpers
Deliverable: HTTP suites use a standard setup path and stop duplicating fragile boilerplate.

Tasks:
1. Add `test/helpers/` utilities for:
   - starting and stopping the app server
   - creating test sessions and auth cookies
   - issuing authenticated API requests
   - creating and cleaning suite-owned fixture rows
2. Stop open-coding `Pool` creation in every HTTP suite where possible.
3. Add helpers for parent and kid session creation so auth coverage becomes normal, not exceptional.
4. Move cleanup into suite-local helpers instead of broad `after()` cleanup patterns.
5. Standardize naming so every suite owns a fixture prefix, for example `categories_api_*`.

Acceptance criteria:
- integration suites can run with auth enabled
- suites can run independently or together with the same results
- setup and teardown code is materially smaller and more consistent

### Phase 5: Refactor The Highest-Risk Suites First
Deliverable: the suites most likely to drift across machines are fixed first.

Priority order:
1. `transactions-api`
2. `categories-api`
3. `link-api`
4. `budget-api`
5. remaining DB-backed suites

Refactor targets:
- replace ambient reads with fixed fixtures
- remove hidden coupling between tests in the same file
- stop mutating shared baseline rows
- make assertions exact where feasible

Acceptance criteria:
- these suites pass after reset on both dev machines
- these suites no longer require pre-existing local data

### Phase 6: CI Alignment
Deliverable: CI runs the same guarded deterministic flow as local development.

Tasks:
1. Provision a dedicated CI test database.
2. Use `.env.test`-equivalent settings in CI.
3. Run `npm run test:ci` in CI, not a bespoke sequence.
4. Fail CI if the test DB guard rejects configuration.

Acceptance criteria:
- CI and local use the same test lifecycle
- CI starts from a clean DB every run

### Phase 7: Optional Runtime and Parallelism Work
Deliverable: faster tests without sacrificing determinism.

Tasks:
1. Keep unit tests parallel-friendly.
2. Decide whether DB integration suites should:
   - run serially, or
   - use isolated schemas per worker
3. Split commands if useful:
   - `test:unit`
   - `test:integration`

Acceptance criteria:
- speed improvements do not reintroduce flaky shared-state failures

## Immediate Backlog
1. Add `test/bootstrap.js` with explicit `.env.test` loading and DB safety rejection.
2. Add `.env.test.example`.
3. Add `test:db:reset`, `test:db:migrate`, `test:db:seed`, and `test:prepare`.
4. Change `npm test` to run the guarded deterministic pipeline.
5. Create baseline fixtures and helper factories.
6. Refactor `transactions-api`, `categories-api`, and `link-api`.
7. Wire the same flow into CI.

## Definition of Done
- both development machines run `npm test` successfully against their own dedicated test DBs
- no test run can hit dev or prod data by accident
- test outcomes are deterministic after a fresh prepare step
- CI is green using the same guarded workflow
- integration tests no longer depend on ambient local data

## Recommended Implementation Notes
- Prefer a schema reset inside a dedicated test database over drop/create DB if local privileges differ between machines.
- Keep baseline fixtures intentionally small.
- Use stable IDs for shared reference rows where that improves readability.
- Use helper-created unique prefixes only for mutable suite data.
- Treat this as a pre-production safety task, not just test cleanup.
