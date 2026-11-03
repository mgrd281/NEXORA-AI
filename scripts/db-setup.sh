#!/usr/bin/env bash
# Creates the JARVIS roles and databases on a local/CI PostgreSQL server.
#
#   jarvis_owner — owns the schema; used only to run migrations.
#   jarvis_app   — runtime role for API + worker. Not the table owner, so
#                  Row-Level Security always applies (NOBYPASSRLS).
#
# Usage: ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres scripts/db-setup.sh
# Passwords below are for local development and CI only. Production roles are
# provisioned by infrastructure with secrets from the secret manager.
set -euo pipefail

ADMIN_URL="${ADMIN_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
OWNER_PASSWORD="${JARVIS_DB_OWNER_PASSWORD:-jarvis_owner_dev}"
APP_PASSWORD="${JARVIS_DB_APP_PASSWORD:-jarvis_app_dev}"
DATABASES="${JARVIS_DATABASES:-jarvis jarvis_test}"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_owner') THEN
    CREATE ROLE jarvis_owner LOGIN PASSWORD '${OWNER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app') THEN
    CREATE ROLE jarvis_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
SQL

for db in $DATABASES; do
  if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $db OWNER jarvis_owner"
  fi
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "REVOKE ALL ON DATABASE $db FROM PUBLIC; GRANT CONNECT ON DATABASE $db TO jarvis_app;"
  # PG15+: public schema is owned by pg_database_owner; make sure the owner role controls it.
  psql "${ADMIN_URL%/*}/$db" -v ON_ERROR_STOP=1 -q -c "ALTER SCHEMA public OWNER TO jarvis_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
  echo "database ready: $db"
done
