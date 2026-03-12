#!/bin/sh
set -eu

TEST_DB="${POSTGRES_TEST_DB:-familypulse_test}"

existing_db_count="$(
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc \
    "SELECT count(*) FROM pg_database WHERE datname = '$TEST_DB';"
)"

if [ "$existing_db_count" = "0" ]; then
  echo "Creating test database: $TEST_DB"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c \
    "CREATE DATABASE \"$TEST_DB\";"
else
  echo "Test database already exists: $TEST_DB"
fi
