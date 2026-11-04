#!/usr/bin/env bash
# Prepares a Railway PostgreSQL service for JARVIS. Same roles, privileges and schema ownership
# as scripts/db-setup.sh, for a server where the database already exists (Railway's default
# database is "railway") and you connect as its superuser over the internet:
#
#   jarvis_owner — owns the schema; used only by migrations (DATABASE_OWNER_URL, the api
#                  service's pre-deploy command).
#   jarvis_app   — runtime role of api, worker and browser-worker (DATABASE_URL). Not the table
#                  owner and NOBYPASSRLS, so Row-Level Security always applies.
#
# It prints the two connection strings to paste into the Railway variables. Run it from your
# computer (needs psql 14 or newer; macOS: brew install libpq) — either through the Railway CLI,
# which hands it the Postgres service's variables:
#
#   railway run --service Postgres bash scripts/railway/bootstrap-db.sh
#
# or with the superuser URL pasted at a hidden prompt (Postgres service → Variables →
# DATABASE_PUBLIC_URL):
#
#   bash scripts/railway/bootstrap-db.sh
#
# Environment (all optional):
#   SUPERUSER_DATABASE_URL  superuser URL; default DATABASE_PUBLIC_URL, then DATABASE_URL, then a
#                           hidden prompt. Reachable from where the script runs.
#   JARVIS_DB_NAME          database for JARVIS; default: the one in that URL. Created (owned by
#                           jarvis_owner) when it does not exist.
#   JARVIS_DB_OWNER_PASSWORD, JARVIS_DB_APP_PASSWORD
#                           passwords to set (16–128 characters of A–Z a–z 0–9 . _ ~ -). Default:
#                           generated for a role that does not exist yet; an existing role keeps
#                           its password.
#   JARVIS_DB_ROTATE=1      give existing roles new generated passwords (then update the Railway
#                           variables and redeploy).
#   JARVIS_DB_PRIVATE_HOST, JARVIS_DB_PRIVATE_PORT
#                           host and port in the printed URLs — the database's address on
#                           Railway's private network. Default: RAILWAY_PRIVATE_DOMAIN or PGHOST
#                           when it ends in .railway.internal, else postgres.railway.internal;
#                           port 5432.
#   PGSSLMODE               default require (encrypted; Railway's certificate is self-signed).
#
# Idempotent: running it again changes nothing unless you ask for new passwords. It never prints
# the superuser password and never puts a password on a command line (psql reads them from its
# environment and standard input). The connection strings go to standard output, everything
# else to standard error — if you redirect them to a file, delete it after pasting.
set -euo pipefail

case "${1:-}" in
-h | --help)
  sed -n '2,43p' "$0"
  exit 0
  ;;
esac

die() {
  echo "bootstrap-db: $*" >&2
  exit 1
}
note() { echo "bootstrap-db: $*" >&2; }

command -v psql >/dev/null 2>&1 ||
  die 'psql is required (macOS: brew install libpq, then add "$(brew --prefix libpq)/bin" to PATH)'

# Railway's private address of the database, captured before PG* is pointed at the public one.
PRIVATE_HOST="${JARVIS_DB_PRIVATE_HOST:-}"
if [[ -z $PRIVATE_HOST ]]; then
  case "${RAILWAY_PRIVATE_DOMAIN:-}" in
  *.railway.internal) PRIVATE_HOST="$RAILWAY_PRIVATE_DOMAIN" ;;
  esac
fi
if [[ -z $PRIVATE_HOST ]]; then
  case "${PGHOST:-}" in
  *.railway.internal) PRIVATE_HOST="$PGHOST" ;;
  esac
fi
PRIVATE_HOST="${PRIVATE_HOST:-postgres.railway.internal}"
PRIVATE_PORT="${JARVIS_DB_PRIVATE_PORT:-5432}"
host_re='^[A-Za-z0-9.-]+$'
port_re='^[0-9]{1,5}$'
[[ $PRIVATE_HOST =~ $host_re ]] || die "JARVIS_DB_PRIVATE_HOST is not a host name"
[[ $PRIVATE_PORT =~ $port_re ]] || die "JARVIS_DB_PRIVATE_PORT is not a port"

url="${SUPERUSER_DATABASE_URL:-${DATABASE_PUBLIC_URL:-${DATABASE_URL:-}}}"
if [[ -z $url ]]; then
  [[ -t 0 ]] || die "set SUPERUSER_DATABASE_URL (or run it through: railway run --service Postgres ...)"
  read -rsp "Superuser URL of the database (DATABASE_PUBLIC_URL; input hidden): " url
  echo >&2
fi
[[ -n $url ]] || die "no database URL given"

# postgres[ql]://user[:password]@host[:port][/database][?query]
re='^postgres(ql)?://([^:@/?#]+)(:([^@/?#]*))?@(\[[0-9A-Fa-f:.]+]|[^]:/?#[]+)(:([0-9]+))?(/([^?#]*))?(\?([^#]*))?$'
[[ $url =~ $re ]] || die "not a postgresql://user:password@host:port/database URL"
urldecode() {
  local s="$1"
  if [[ $s == *%* ]]; then printf '%b' "${s//\%/\\x}"; else printf '%s' "$s"; fi
}
SU_USER="$(urldecode "${BASH_REMATCH[2]}")"
SU_PASSWORD="$(urldecode "${BASH_REMATCH[4]}")"
SU_HOST="${BASH_REMATCH[5]}"
SU_HOST="${SU_HOST#\[}"
SU_HOST="${SU_HOST%\]}"
SU_PORT="${BASH_REMATCH[7]:-5432}"
SU_DB="$(urldecode "${BASH_REMATCH[9]:-}")"
query="${BASH_REMATCH[11]:-}"
unset url
SU_DB="${SU_DB:-postgres}"
DB="${JARVIS_DB_NAME:-$SU_DB}"
db_re='^[a-z_][a-z0-9_]{0,62}$'
[[ $DB =~ $db_re ]] ||
  die "database name '$DB' must be lower-case letters, digits and _ (set JARVIS_DB_NAME)"
case "$SU_HOST" in
*.railway.internal)
  die "$SU_HOST is Railway's private address, which your computer cannot reach: use DATABASE_PUBLIC_URL" ;;
esac

sslmode="${PGSSLMODE:-require}"
ssl_re='(^|&)sslmode=([a-z-]+)'
if [[ $query =~ $ssl_re ]]; then sslmode="${BASH_REMATCH[2]}"; fi

# libpq reads these; nothing secret ends up in argv. Clear what `railway run` may have set.
unset PGSERVICE PGSERVICEFILE PGPASSFILE PGOPTIONS PGTARGETSESSIONATTRS
export PGHOST="$SU_HOST" PGPORT="$SU_PORT" PGUSER="$SU_USER" PGPASSWORD="$SU_PASSWORD"
export PGSSLMODE="$sslmode" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}" PGAPPNAME=jarvis-bootstrap
unset SU_PASSWORD

# psql against database $1, SQL on standard input. -X: ignore ~/.psqlrc.
sql() { PGDATABASE="$1" psql -X -q -v ON_ERROR_STOP=1 -At; }
sql_value() { printf '%s\n' "$2" | sql "$1"; }

note "connecting to $SU_HOST:$SU_PORT/$SU_DB as $SU_USER (sslmode=$PGSSLMODE)"
is_super="$(sql_value "$SU_DB" "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;")" ||
  die "could not connect (check the URL, that the database's public TCP proxy is on, and PGSSLMODE)"
[[ $is_super == t ]] ||
  die "$SU_USER is not a superuser; this script is for Railway's postgres user (managed providers differ)"
version="$(sql_value "$SU_DB" "SHOW server_version_num;")"
((version >= 140000)) || die "PostgreSQL 14 or newer is required (server reports $version)"
extensions="$(sql_value "$SU_DB" "SELECT count(*) FROM pg_available_extensions WHERE name IN ('citext', 'pgcrypto', 'pg_trgm');")"
[[ $extensions == 3 ]] || die "the server lacks the citext, pgcrypto or pg_trgm extension (contrib)"

# --- passwords --------------------------------------------------------------------------------
generate() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
  fi
}
role_exists() {
  [[ "$(sql_value "$SU_DB" "SELECT count(*) FROM pg_roles WHERE rolname = '$1';")" == 1 ]]
}
# password_for ROLE PROVIDED → the password to set now, or "" to leave it unchanged.
password_for() {
  local role="$1" provided="$2"
  if [[ -n $provided ]]; then
    local pw_re='^[A-Za-z0-9._~-]{16,128}$'
    [[ $provided =~ $pw_re ]] ||
      die "the password for $role must be 16–128 characters of A-Z a-z 0-9 . _ ~ -"
    printf '%s' "$provided"
  elif ! role_exists "$role" || [[ ${JARVIS_DB_ROTATE:-0} == 1 ]]; then
    generate
  fi
}
OWNER_PASSWORD="$(password_for jarvis_owner "${JARVIS_DB_OWNER_PASSWORD:-}")"
APP_PASSWORD="$(password_for jarvis_app "${JARVIS_DB_APP_PASSWORD:-}")"

# --- roles ------------------------------------------------------------------------------------
# The passwords travel on standard input as psql variables and are quoted by the server (%L).
{
  printf '\\set owner_password %s\n' "'${OWNER_PASSWORD}'"
  printf '\\set app_password %s\n' "'${APP_PASSWORD}'"
  cat <<'SQL'
SELECT format('CREATE ROLE jarvis_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_owner')
\gexec
SELECT format('CREATE ROLE jarvis_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
              :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app')
\gexec
-- A role that already existed gets a new password only when one was chosen above.
SELECT format('ALTER ROLE jarvis_owner PASSWORD %L', :'owner_password') WHERE :'owner_password' <> ''
\gexec
SELECT format('ALTER ROLE jarvis_app PASSWORD %L', :'app_password') WHERE :'app_password' <> ''
\gexec
-- The runtime role must never bypass Row-Level Security, whoever created it.
ALTER ROLE jarvis_owner LOGIN NOSUPERUSER;
ALTER ROLE jarvis_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
} | sql "$SU_DB"
note "roles ready: jarvis_owner, jarvis_app"

# --- database ---------------------------------------------------------------------------------
if [[ "$(sql_value "$SU_DB" "SELECT count(*) FROM pg_database WHERE datname = '$DB';")" != 1 ]]; then
  sql_value "$SU_DB" "CREATE DATABASE $DB OWNER jarvis_owner;"
  note "created database $DB (owner jarvis_owner)"
fi
foreign="$(sql_value "$DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'jarvis_owner';")"
if [[ $foreign != 0 && ${JARVIS_DB_ALLOW_EXISTING:-0} != 1 ]]; then
  die "the public schema of $DB already holds $foreign tables, views or sequences that jarvis_owner does not own; use an empty database (JARVIS_DB_NAME=jarvis creates one), or JARVIS_DB_ALLOW_EXISTING=1 if you know why"
fi
# Like scripts/db-setup.sh: nobody but these roles may connect; jarvis_owner may create the
# (trusted) extensions and objects the migrations need even when the superuser owns the database.
sql "$DB" <<SQL
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE $DB TO jarvis_owner;
GRANT CONNECT ON DATABASE $DB TO jarvis_app;
-- PG15+: public is owned by pg_database_owner; the owner role must control it.
ALTER SCHEMA public OWNER TO jarvis_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
note "database ready: $DB"

# --- connection strings -----------------------------------------------------------------------
print_url() {
  local name="$1" role="$2" password="$3"
  if [[ -n $password ]]; then
    printf '%s=postgresql://%s:%s@%s:%s/%s\n' "$name" "$role" "$password" "$PRIVATE_HOST" "$PRIVATE_PORT" "$DB"
  else
    printf '%s=postgresql://%s:<unchanged: keep the password already in Railway>@%s:%s/%s\n' \
      "$name" "$role" "$PRIVATE_HOST" "$PRIVATE_PORT" "$DB"
  fi
}
echo >&2
note "Paste into Railway (Variables). DATABASE_OWNER_URL: api service only (its pre-deploy"
note "migrations). DATABASE_URL: api, worker and browser-worker. Mark both as secrets (sealed)."
note "Never use the Postgres service's own DATABASE_URL (the superuser) for JARVIS: it bypasses"
note "Row-Level Security."
print_url DATABASE_OWNER_URL jarvis_owner "$OWNER_PASSWORD"
print_url DATABASE_URL jarvis_app "$APP_PASSWORD"
echo >&2
note "These use the private address $PRIVATE_HOST:$PRIVATE_PORT (reachable from Railway services"
note "only). From your computer the same roles connect through the public address $SU_HOST:$SU_PORT."
