#!/usr/bin/env bash
# Runs the whole local stack with prefixed logs; Ctrl-C stops everything.
#
#   scripts/dev.sh
#
# Starts PostgreSQL if needed (scripts/ensure-postgres.sh), applies migrations, then runs:
#   api       http://127.0.0.1:4000   (PORT in apps/api/.env; tsx watch)
#   worker    durable job worker      (tsx watch)
#   mailbox   SMTP 127.0.0.1:2525, messages at http://127.0.0.1:2580/messages
#   fixture   http://127.0.0.1:4599/  (pages for web.fetch)
#   web       http://localhost:3000
# If any of them exits, the others are stopped too.
#
# Prerequisites (README quickstart): pnpm install, apps/api/.env, scripts/db-setup.sh once.
# Options (environment):
#   DEV_SKIP="web mailbox"   leave services out (names as above)
#   DEV_SKIP_MIGRATE=1       do not run migrations
#   MAILBOX_SMTP_PORT, MAILBOX_HTTP_PORT, FIXTURE_PORT, API_ORIGIN   override defaults
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=apps/api/.env

if [[ -t 1 ]]; then bold=$'\033[1m' yellow=$'\033[33m' red=$'\033[31m' reset=$'\033[0m'; else
  bold='' yellow='' red='' reset=''
fi
info() { printf '%s[dev]%s %s\n' "$bold" "$reset" "$*"; }
warn() { printf '%s[dev] warning:%s %s\n' "$yellow" "$reset" "$*" >&2; }
die() {
  printf '%s[dev] error:%s %s\n' "$red" "$reset" "$*" >&2
  exit 1
}

command -v pnpm >/dev/null || die "pnpm is not installed (corepack enable)"
[[ -d node_modules ]] || die "dependencies are not installed: run pnpm install --frozen-lockfile"
[[ -f $ENV_FILE ]] ||
  die "$ENV_FILE is missing: cp .env.example $ENV_FILE and set SECRET_ENCRYPTION_KEY (see README)"

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '"'"'"'\r'; }

export MAILBOX_SMTP_PORT="${MAILBOX_SMTP_PORT:-2525}"
export MAILBOX_HTTP_PORT="${MAILBOX_HTTP_PORT:-2580}"
export FIXTURE_PORT="${FIXTURE_PORT:-4599}"
API_PORT="$(env_value PORT)"
API_PORT="${API_PORT:-4000}"
export API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:$API_PORT}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
WEB_PORT=3000 # fixed by apps/web "dev" script

skip=" $(printf '%s' "${DEV_SKIP:-}" | tr ',' ' ') "
enabled() { [[ $skip != *" $1 "* ]]; }

# Dev-only allowances the local helpers need (the API refuses them in production).
if enabled fixture && [[ ",$(env_value FETCH_ALLOW_PRIVATE_HOSTS)," != *",127.0.0.1:$FIXTURE_PORT,"* ]]; then
  warn "FETCH_ALLOW_PRIVATE_HOSTS in $ENV_FILE does not include 127.0.0.1:$FIXTURE_PORT; web.fetch will refuse the fixture site"
fi
if enabled mailbox && [[ ! $(env_value SMTP_ALLOW_INSECURE_LOCALHOST) =~ ^(true|1)$ ]]; then
  warn "SMTP_ALLOW_INSECURE_LOCALHOST is not true in $ENV_FILE; connecting the dev mailbox (no TLS) will be refused"
fi

# Refuse to start on ports that are already taken, instead of failing halfway.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
busy=()
enabled api && port_busy "$API_PORT" && busy+=("api:$API_PORT")
enabled web && port_busy "$WEB_PORT" && busy+=("web:$WEB_PORT")
enabled mailbox && port_busy "$MAILBOX_SMTP_PORT" && busy+=("mailbox:$MAILBOX_SMTP_PORT")
enabled mailbox && port_busy "$MAILBOX_HTTP_PORT" && busy+=("mailbox:$MAILBOX_HTTP_PORT")
enabled fixture && port_busy "$FIXTURE_PORT" && busy+=("fixture:$FIXTURE_PORT")
((${#busy[@]} == 0)) || die "ports already in use: ${busy[*]} (another dev.sh running?)"

# PostgreSQL: start the local cluster if the database in DATABASE_URL is on this machine.
db_url="$(env_value DATABASE_URL)"
[[ -n $db_url ]] || die "DATABASE_URL is not set in $ENV_FILE"
read -r db_host db_port < <(node -e 'const u = new URL(process.argv[1]);
  console.log(u.hostname || "localhost", u.port || 5432)' "$db_url") ||
  die "DATABASE_URL in $ENV_FILE is not a valid URL"
if command -v pg_isready >/dev/null && ! pg_isready -h "$db_host" -p "$db_port" -q; then
  if [[ $db_host == localhost || $db_host == 127.0.0.1 ]]; then
    info "starting PostgreSQL"
    bash scripts/ensure-postgres.sh >/dev/null || die "could not start PostgreSQL on $db_host:$db_port"
  else
    die "PostgreSQL at $db_host:$db_port is not accepting connections"
  fi
fi

if [[ ${DEV_SKIP_MIGRATE:-} != 1 ]]; then
  info "applying migrations"
  pnpm --silent --filter @jarvis/api db:migrate ||
    die "migrations failed (first time? run scripts/db-setup.sh — see README)"
fi

# Each service runs in its own process group (job control), so stopping a group also stops
# the processes it spawned (pnpm → tsx → node). stdin is /dev/null: background groups must
# not read the terminal.
set -m
names=()
pids=()
if [[ -t 1 ]]; then colors=(36 35 33 32 34); else colors=(); fi
# Line-by-line in bash: awk implementations differ in how they buffer pipe input (mawk).
prefix() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do printf '%s %s\n' "$1" "$line"; done
}
start() {
  local name="$1" label
  shift
  label="$(printf '%-8s|' "$name")"
  if ((${#colors[@]})); then label=$'\033['"${colors[${#names[@]} % ${#colors[@]}]}m$label"$'\033[0m'; fi
  ("$@" </dev/null 2>&1 | prefix "$label") &
  names+=("$name")
  pids+=("$!")
}

stopping=0
stop() {
  ((stopping)) && return
  stopping=1
  set +m # no job-status notices while shutting down
  ((${#pids[@]})) || return 0
  info "stopping ${names[*]}"
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for _ in $(seq 1 50); do
    local alive=0
    for pid in "${pids[@]}"; do kill -0 -- "-$pid" 2>/dev/null && alive=1; done
    ((alive)) || return 0
    sleep 0.2
  done
  warn "some processes did not stop within 10 s; killing them"
  for pid in "${pids[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
}
trap 'stop; exit 130' INT
trap 'stop; exit 143' TERM
trap stop EXIT

enabled api && start api pnpm --filter @jarvis/api dev
enabled worker && start worker pnpm --filter @jarvis/api dev:worker
enabled mailbox && start mailbox pnpm --filter @jarvis/api dev:mailbox
enabled fixture && start fixture node scripts/fixture-site.mjs --port "$FIXTURE_PORT"
enabled web && start web pnpm --filter @jarvis/web dev
((${#pids[@]})) || die "DEV_SKIP left nothing to run"

# Supervise: report readiness once, and stop everything if any service exits.
urls=()
enabled api && urls+=("http://127.0.0.1:$API_PORT/readyz")
enabled web && urls+=("http://localhost:$WEB_PORT/")
announced=0
while :; do
  for i in "${!pids[@]}"; do
    if ! kill -0 "${pids[$i]}" 2>/dev/null; then
      warn "${names[$i]} exited; stopping the others"
      exit 1
    fi
  done
  if ((!announced)) && command -v curl >/dev/null; then
    ready=1
    for url in ${urls[@]+"${urls[@]}"}; do
      curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null || ready=0
    done
    if ((ready)); then
      announced=1
      info "ready — Ctrl-C stops everything"
      enabled web && info "  web      http://localhost:$WEB_PORT"
      enabled api && info "  api      http://127.0.0.1:$API_PORT (healthz, readyz)"
      enabled mailbox && info "  mailbox  smtp 127.0.0.1:$MAILBOX_SMTP_PORT (security none), http://127.0.0.1:$MAILBOX_HTTP_PORT/messages"
      enabled fixture && info "  fixture  http://127.0.0.1:$FIXTURE_PORT/article"
    fi
  fi
  sleep 1
done
