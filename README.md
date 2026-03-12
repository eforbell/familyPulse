# Family Pulse

## Local Test Setup

Tests are guarded to prevent accidental writes against a normal development or production database.

### One-time setup on each machine

1. Start Postgres with `docker compose up -d db`.
2. Copy `.env.test.example` to `.env.test`.
3. Keep `.env` pointed at `familypulse`.
4. Keep `.env.test` pointed at `familypulse_test`.

The default Docker setup now creates two databases in one container:
- `familypulse`
- `familypulse_test`

If your `db` container was initialized before this change, the second database will not appear automatically because Postgres init scripts only run on first boot of a fresh data volume. In that case either:
- create `familypulse_test` manually once, or
- recreate the Docker volume and reinitialize the container

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

The default Docker setup uses one Postgres container with two databases:
- `familypulse` for normal development
- `familypulse_test` for test runs

The second database is created by [db/initdb/01-create-test-db.sh](/Volumes/DATA/workspace/homeApps/familyPulse/db/initdb/01-create-test-db.sh), which is mounted through [docker-compose.yml](/Volumes/DATA/workspace/homeApps/familyPulse/docker-compose.yml).

### Important behavior

Postgres only runs `/docker-entrypoint-initdb.d/*` scripts when initializing a fresh data directory. That means:
- deleting the container alone is not enough
- if the named volume still exists, the init script will be skipped on next start

### Normal startup

Use:

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
