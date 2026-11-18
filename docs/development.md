# Development

How Family Pulse is put together and how to run and test it locally. For what the app does, see the [README](../README.md).

## Architecture

Family Pulse is intentionally small and direct:

- Express server with static pages and browser JS from `public/` (no build step)
- PostgreSQL for all application state
- Plaid for account linking and transaction sync
- optional OpenAI-powered digest, Ask Pulse, and what-if features
- an optional read-only MCP server (`mcp/server.js`)

## Project layout

- [server.js](../server.js): app bootstrap, middleware, route mounting, cron jobs
- [lib/routes](../lib/routes): API route modules
- [lib](../lib): business logic, sync, auth, budgeting, anomaly detection, AI helpers
- [public](../public): frontend pages and browser JS
- [db/migrations](../db/migrations): schema migrations
- [db/seed.sql](../db/seed.sql): deterministic baseline seed data
- [test](../test): unit and integration tests
- [mcp](../mcp): read-only MCP server
- [deploy](../deploy): systemd units and deploy scripts

## Local development

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

### Apply migrations

```sh
node db/migrate.js
```

Migrations are idempotent. Re-run after pulling changes that add files to `db/migrations/`.

### Run the app

```sh
npm install
npm start
```

Default app URL:

```text
http://localhost:3003
```

With an empty database the app opens first-run setup, which creates the household and default categories. For a quick local sandbox with the sample family instead, load `db/seed.sql`:

```sh
psql "$DATABASE_URL" -f db/seed.sql
```

## Authentication

The app supports household member sessions with parent and kid roles.

- when no passphrases are configured yet, initial setup is protected by `BOOTSTRAP_SECRET`
- once passphrases exist, API and page access are session-gated
- parent-only routes protect administrative and account-linking actions
- kid access is scoped through `account_members`

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

## Docker test database harness

The second database is created by [db/initdb/01-create-test-db.sh](../db/initdb/01-create-test-db.sh), which is mounted through [docker-compose.yml](../docker-compose.yml).

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

## README screenshots

The README images come from a fictional household, never from a real instance. [scripts/demo-showcase.js](../scripts/demo-showcase.js) builds it and captures the images:

```sh
docker compose exec -T db psql -U familypulse -d postgres -c 'CREATE DATABASE familypulse_showcase'
export DATABASE_URL=postgresql://familypulse:<password>@localhost:5434/familypulse_showcase
node scripts/demo-showcase.js seed

# in another shell, with the same DATABASE_URL
PORT=3097 PLAID_CLIENT_ID=demo PLAID_SECRET=demo PLAID_ENV=sandbox node server.js

node scripts/demo-showcase.js screenshots      # writes docs/images/*.png
```

`seed` refuses any database whose name lacks `demo` or `showcase`, and any database that already has transactions. Dates are relative to today, so re-run it on a freshly created database when the images need refreshing. Leave the demo database without passphrases: `screenshots` signs in as the demo parent through the member picker.
