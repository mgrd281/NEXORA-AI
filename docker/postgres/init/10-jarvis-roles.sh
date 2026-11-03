#!/usr/bin/env bash
# First-start initialisation for the postgres container in docker-compose.yml. Creates the same
# roles, databases and privileges as scripts/db-setup.sh:
#
#   jarvis_owner — owns the schema; used only to run migrations.
#   jarvis_app   — runtime role for API + worker. Not the table owner, so Row-Level Security
#                  always applies (NOBYPASSRLS).
#
# The official image runs /docker-entrypoint-initdb.d/* only when the data volume is empty;
# to re-run it, remove the volume (docker compose down -v — this deletes all data).
# Passwords come from the environment (set in .env, never committed) and are quoted by the
# server with format(%L), so any character is safe.
set -euo pipefail

: "${JARVIS_DB_OWNER_PASSWORD:?JARVIS_DB_OWNER_PASSWORD is required}"
: "${JARVIS_DB_APP_PASSWORD:?JARVIS_DB_APP_PASSWORD is required}"
DATABASES="${JARVIS_DATABASES:-jarvis}"

psql=(psql -v ON_ERROR_STOP=1 -q --username "${POSTGRES_USER:-postgres}" --no-password)

"${psql[@]}" --dbname postgres \
  -v owner_password="$JARVIS_DB_OWNER_PASSWORD" \
  -v app_password="$JARVIS_DB_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE jarvis_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_owner')
\gexec
SELECT format('CREATE ROLE jarvis_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
              :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app')
\gexec
SQL

for db in $DATABASES; do
  if [[ ! $db =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "invalid database name: $db" >&2
    exit 1
  fi
  if ! "${psql[@]}" --dbname postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    "${psql[@]}" --dbname postgres -c "CREATE DATABASE $db OWNER jarvis_owner"
  fi
  "${psql[@]}" --dbname postgres -c "REVOKE ALL ON DATABASE $db FROM PUBLIC; GRANT CONNECT ON DATABASE $db TO jarvis_app;"
  # PG15+: public schema is owned by pg_database_owner; make sure the owner role controls it.
  "${psql[@]}" --dbname "$db" -c "ALTER SCHEMA public OWNER TO jarvis_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
  echo "database ready: $db"
done
