# Family Pulse

Family Pulse is a household finance dashboard for the Forbell family. It pulls account and transaction data from Plaid, organizes spending into household-friendly categories, tracks budget periods and snapshots, flags anomalies, and supports lightweight AI-generated summaries and planning prompts.

The app is intentionally small and direct:
- Express server with server-rendered static pages from `public/`
- PostgreSQL for all application state
- Plaid for account linking and transaction sync
- optional OpenAI-powered digest and what-if features

## Core Capabilities

- link household financial institutions through Plaid
- sync accounts and transactions into a local PostgreSQL database
- review balances, transactions, budgets, and reports in a simple web UI
- categorize spending with manual edits plus reusable rules
- snapshot monthly budget state for historical reporting
- detect unusual category spending
- support parent/kid household access with session auth and account scoping
- generate weekly digest, monthly close, and what-if style AI outputs

## Project Layout

- [server.js](/Volumes/DATA/workspace/homeApps/familyPulse/server.js): app bootstrap, middleware, route mounting, cron jobs
- [lib/routes](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes): API route modules
- [lib](/Volumes/DATA/workspace/homeApps/familyPulse/lib): business logic, sync, auth, budgeting, anomaly detection, AI helpers
- [public](/Volumes/DATA/workspace/homeApps/familyPulse/public): frontend pages and browser JS
- [db/migrations](/Volumes/DATA/workspace/homeApps/familyPulse/db/migrations): schema migrations
- [db/seed.sql](/Volumes/DATA/workspace/homeApps/familyPulse/db/seed.sql): deterministic baseline seed data
- [test](/Volumes/DATA/workspace/homeApps/familyPulse/test): unit and integration tests

## Local Development

### Prerequisites

- Node.js
- Docker with Docker Compose

### Start the database

```sh
docker compose up -d db
```

The default Docker setup uses one Postgres container with two databases:
- `familypulse` for normal development
- `familypulse_test` for test runs

### Environment files

- use `.env` for normal app development
- use `.env.test` for test execution
- `.env.example` and `.env.test.example` provide templates

Important variables:
- `DATABASE_URL`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV`
- `OPENAI_API_KEY`
- `BOOTSTRAP_SECRET`

### Run the app

```sh
npm install
npm start
```

Default app URL:

```text
http://localhost:3003
```

### Reset linked financial data

If you previously linked sandbox institutions and want to start fresh before switching to production Plaid credentials, the safest path is usually to clear linked financial data from the database instead of trying to clean it up manually in the UI.

This script preserves:
- `family_members`
- `sessions`
- `app_config`
- `categories`
- `category_rules`
- `schema_migrations`

It clears:
- Plaid-linked `items`
- `accounts` via cascade
- `transactions` via cascade
- `account_members` via cascade
- `link_sessions`
- `import_runs`
- `anomalies`
- `budget_snapshots`
- `magic_actions_log`

It preserves the `monarch-import` sentinel item so historical Monarch CSV import continues to work after the reset.

Run it intentionally:

```sh
npm run db:clear-linked-data
```

Or directly:

```sh
node db/clear-linked-data.js --yes
```

## Authentication

The app supports household member sessions with parent and kid roles.

- when no passphrases are configured yet, initial setup is protected by `BOOTSTRAP_SECRET`
- once passphrases exist, API and page access are session-gated
- parent-only routes protect administrative and account-linking actions
- kid access is scoped through `account_members`

## Plaid Behavior Notes

Family Pulse now supports editing the synced account set for an existing Plaid Item through update mode, and preserves de-selected accounts locally as historical instead of deleting them.

A few institution behaviors are worth knowing up front:

- Many OAuth institutions appear to be effectively add-only from Plaid Link's point of view.
- In production testing, both `Chase` and `Capital One` allowed adding newly shared accounts more easily than removing a single account from an existing Item.
- Some institutions expose removal only as a full app disconnect on the bank side, not as a granular per-account de-selection flow for Family Pulse.
- Because of that, `Edit synced accounts` should be treated as a best-effort review/add flow, not a guarantee of symmetric add/remove control across all institutions.
- If an Item needs a permission reset, or if liabilities were never added to a legacy bundled Item, the practical remedy may be `Disconnect` followed by a fresh `Link Institution`.

Current app behavior:

- `Disconnect` removes the Plaid Item remotely and stops future sync/billing, but preserves local history.
- `Purge` is the explicit destructive action for deleting preserved local history after a disconnect.
- Historical accounts remain visible for past transactions and account history, but they no longer affect live balance totals.

## Backup Restore Drill

Run a monthly restore drill to prove backups are fully recoverable:
- [planning/restore-drill.md](/home/forbell/workspace/homeApps/familyPulse/planning/restore-drill.md)

The runbook is written for `pg_dump -Fc` backups and `pg_restore` validation into an isolated drill database.

## Testing

Tests are guarded to prevent accidental writes against a normal development or production database.

### One-time setup on each machine

1. Start Postgres with `docker compose up -d db`.
2. Copy `.env.test.example` to `.env.test`.
3. Keep `.env` pointed at `familypulse`.
4. Keep `.env.test` pointed at `familypulse_test`.

If your `db` container was initialized before the two-database setup existed, the second database will not appear automatically because Postgres init scripts only run on first boot of a fresh data volume. In that case either:
- create `familypulse_test` manually once
- or recreate the Docker volume and reinitialize the container

### Running tests

- `npm test` preloads `test/bootstrap.js`
- `npm test` also resets, migrates, and seeds the dedicated test DB first
- the bootstrap loads `.env.test`
- the bootstrap forces `NODE_ENV=test`
- the bootstrap rejects any `DATABASE_URL` that does not clearly target a test database

If the guard fails, fix `.env.test` instead of pointing tests at your regular dev database.

Useful commands:

```sh
npm test
npm run test:fast
npm run test:db:reset
npm run test:db:migrate
npm run test:db:seed
npm run test:prepare
```

Command behavior:
- `npm test`: deterministic run, including reset -> migrate -> seed -> test
- `npm run test:fast`: runs tests against the already-prepared test DB without resetting it
- `npm run test:prepare`: prepares the test DB without running the test suite

## Docker Test Database Harness

The second database is created by [db/initdb/01-create-test-db.sh](/Volumes/DATA/workspace/homeApps/familyPulse/db/initdb/01-create-test-db.sh), which is mounted through [docker-compose.yml](/Volumes/DATA/workspace/homeApps/familyPulse/docker-compose.yml).

### Important behavior

Postgres only runs `/docker-entrypoint-initdb.d/*` scripts when initializing a fresh data directory. That means:
- deleting the container alone is not enough
- if the named volume still exists, the init script will be skipped on next start

### Normal startup

```sh
docker compose up -d db
```

### Clean rebuild from scratch

Use this when you want Postgres to re-run the init scripts and recreate both databases from a clean volume:

```sh
docker compose down -v
docker compose up -d db
```

This removes:
- the running `db` container
- the Compose network
- the named Postgres volume

After that, the next `docker compose up -d db` performs a true first-time initialization.

### Verify the databases exist

```sh
docker compose exec -T db psql -U familypulse -d postgres -tAc "SELECT datname FROM pg_database ORDER BY datname;"
```

Expected output includes:
- `familypulse`
- `familypulse_test`

### If `familypulse_test` is missing

The most likely cause is that the Postgres volume was reused and initialization was skipped. Run the clean rebuild steps above if you are comfortable discarding the local Docker database state.
