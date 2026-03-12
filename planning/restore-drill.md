# PostgreSQL Restore Drill Runbook

Purpose: prove backups can reconstitute Family Pulse state without re-linking Plaid.

## Scope

This drill validates:
- backup file integrity
- restore into an isolated database
- critical state presence (items/accounts/transactions/categories/config)
- app-level startup against restored data

This drill does not modify production.

## Backup format

Preferred dump format:

```sh
pg_dump -Fc -f /path/to/backups/familypulse_YYYYMMDD_HHMM.dump "$DATABASE_URL"
```

`-Fc` is PostgreSQL custom format (compressed, `pg_restore` compatible).

## Monthly drill checklist

1. Select a recent backup file (ideally < 7 days old).
2. Create a temporary restore database.
3. Restore backup into the temporary database.
4. Run validation queries.
5. Start app against restored DB and hit `/api/health`.
6. Record pass/fail and cleanup.

## Drill commands

Assumptions:
- restore target host has matching PostgreSQL major version
- backup file is custom format (`.dump`)

Set variables:

```sh
export DRILL_DB="familypulse_restore_drill"
export DRILL_DUMP="/path/to/backups/familypulse_YYYYMMDD_HHMM.dump"
export PGURL_ADMIN="postgresql://USER:PASS@HOST:5432/postgres"
export DRILL_DB_URL="postgresql://USER:PASS@HOST:5432/${DRILL_DB}"
```

Create fresh drill DB:

```sh
psql "$PGURL_ADMIN" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};"
psql "$PGURL_ADMIN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DRILL_DB};"
```

Restore:

```sh
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname="$DRILL_DB_URL" \
  "$DRILL_DUMP"
```

## Validation queries

Run:

```sh
psql "$DRILL_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'items' AS table, count(*) FROM items
UNION ALL SELECT 'accounts', count(*) FROM accounts
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'categories', count(*) FROM categories
UNION ALL SELECT 'import_runs', count(*) FROM import_runs
UNION ALL SELECT 'dedup_runs', count(*) FROM dedup_runs
UNION ALL SELECT 'app_config', count(*) FROM app_config
ORDER BY table;
SQL
```

Sanity checks:

```sh
psql "$DRILL_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) AS plaid_items FROM items WHERE item_id <> 'monarch-import';
SELECT count(*) AS hidden_tx FROM transactions WHERE is_hidden = true;
SELECT max(date) AS latest_tx_date FROM transactions;
SQL
```

## App startup check

Use a temporary env file that points `DATABASE_URL` to `DRILL_DB_URL`, then:

```sh
npm start
```

Verify:
- `GET /api/health` returns `{"status":"ok", ...}`
- settings/accounts/transactions pages load expected data shape

Stop app after check.

## Pass criteria

Drill is a pass only if all are true:
- `pg_restore` exits 0
- validation queries run successfully
- expected core tables have non-zero counts (except optional empty tables)
- app starts and `/api/health` is ok

## Failure handling

If drill fails:
1. Keep the failing dump file.
2. Save exact command output and error.
3. Run drill with the previous backup file.
4. Open an issue in `planning/progress.txt` with root cause and fix.

## Cleanup

```sh
psql "$PGURL_ADMIN" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};"
```

## Suggested cadence

- Monthly restore drill
- Additional drill after any major PostgreSQL version change
- Additional drill after backup tooling changes

