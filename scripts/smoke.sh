#!/usr/bin/env bash
# Smoke test for a running JARVIS API: liveness, readiness, sign-in, profile, assistant status
# (worker heartbeat) and sign-out. Exits non-zero on the first failure.
#
#   SMOKE_EMAIL=you@example.com scripts/smoke.sh [API_URL]     # default http://127.0.0.1:4000
#
# The password is read from SMOKE_PASSWORD, or prompted for (hidden) when unset — it is never
# taken as an argument, printed, or put on a command line. SMOKE_ORIGIN (default
# http://localhost:3000) must equal the API's WEB_ORIGIN: sign-out is a cookie-authenticated
# mutation and the API checks Origin. The session created here is revoked at the end.
set -euo pipefail

API="${1:-${SMOKE_API_URL:-http://127.0.0.1:4000}}"
API="${API%/}"
ORIGIN="${SMOKE_ORIGIN:-http://localhost:3000}"
EMAIL="${SMOKE_EMAIL:-}"

for tool in curl node; do
  command -v "$tool" >/dev/null || { echo "smoke: $tool is required" >&2; exit 2; }
done
if [[ -z "$EMAIL" ]]; then
  echo "smoke: set SMOKE_EMAIL (and SMOKE_PASSWORD, or enter it when prompted)" >&2
  exit 2
fi
if [[ -z "${SMOKE_PASSWORD:-}" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "Password for $EMAIL: " SMOKE_PASSWORD
    echo
  else
    echo "smoke: SMOKE_PASSWORD is not set and there is no terminal to prompt on" >&2
    exit 2
  fi
fi
export SMOKE_EMAIL="$EMAIL" SMOKE_PASSWORD

work="$(mktemp -d)"
chmod 700 "$work"
jar="$work/cookies"
logged_in=0
cleanup() {
  if [[ $logged_in == 1 ]]; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$jar" -H "Origin: $ORIGIN" \
      "$API/v1/auth/logout" 2>/dev/null || true)"
    [[ $code == 204 ]] ||
      echo "  warn  could not revoke the smoke-test session (HTTP $code); revoke \"smoke.sh\" under Settings → Sessions" >&2
  fi
  rm -rf "$work"
}
trap cleanup EXIT

pass() { printf '  ok    %s\n' "$*"; }
fail() {
  printf '  FAIL  %s\n' "$*" >&2
  exit 1
}

# request NAME METHOD PATH [curl args...] -> body in $work/NAME.json, status in $status
request() {
  local name="$1" method="$2" path="$3"
  shift 3
  status="$(curl -sS -o "$work/$name.json" -w '%{http_code}' --max-time 15 -X "$method" \
    -H 'Accept: application/json' "$@" "$API$path")" || fail "$method $path: could not connect to $API"
}

# json NAME EXPR -> evaluates EXPR against the parsed body (as `b`) and prints the result
json() {
  node -e '
    const fs = require("fs");
    let b;
    try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
    const v = new Function("b", "return (" + process.argv[2] + ")")(b);
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$work/$1.json" "$2"
}

echo "JARVIS smoke test against $API"

request healthz GET /healthz
[[ $status == 200 && "$(json healthz 'b.ok')" == true ]] || fail "GET /healthz -> $status"
pass "GET /healthz"

request readyz GET /readyz
[[ $status == 200 && "$(json readyz 'b.database')" == true ]] ||
  fail "GET /readyz -> $status (database reachable: $(json readyz 'b.database' || echo unknown))"
pass "GET /readyz (database reachable)"

# Body is built by node from the environment so the password never appears in argv.
node -e 'process.stdout.write(JSON.stringify({ email: process.env.SMOKE_EMAIL,
  password: process.env.SMOKE_PASSWORD, deviceName: "smoke.sh", platform: "web" }))' \
  >"$work/login-body.json"
request login POST /v1/auth/login -c "$jar" -H 'Content-Type: application/json' \
  --data-binary "@$work/login-body.json"
rm -f "$work/login-body.json"
if [[ $status != 200 ]]; then
  fail "POST /v1/auth/login -> $status: $(json login 'b.error && b.error.code + " " + b.error.message' || true)"
fi
logged_in=1
pass "POST /v1/auth/login as $(json login 'b.user.email') (session $(json login 'b.session.id'))"

request me GET /v1/me -b "$jar"
[[ $status == 200 ]] || fail "GET /v1/me -> $status"
pass "GET /v1/me: $(json me 'b.displayName'), roles $(json me 'b.roles.join(",")'), locale $(json me 'b.locale')"

request status GET /v1/assistant/status -b "$jar"
[[ $status == 200 ]] || fail "GET /v1/assistant/status -> $status"
planner="$(json status 'b.planner.mode + (b.planner.reason ? " (" + b.planner.reason + ")" : "")' || true)"
if [[ "$(json status 'b.worker.healthy')" != true ]]; then
  fail "worker is not healthy (last heartbeat: $(json status 'b.worker.lastHeartbeatAt' || true)); tasks will not run until a worker is up"
fi
pass "GET /v1/assistant/status: version $(json status 'b.version'), planner $planner, worker healthy"

request logout POST /v1/auth/logout -b "$jar" -H "Origin: $ORIGIN"
[[ $status == 204 ]] || fail "POST /v1/auth/logout -> $status (is SMOKE_ORIGIN equal to the API's WEB_ORIGIN?)"
logged_in=0
pass "POST /v1/auth/logout (session revoked)"

request after GET /v1/me -b "$jar"
[[ $status == 401 ]] || fail "GET /v1/me after sign-out -> $status (expected 401)"
pass "GET /v1/me after sign-out -> 401"

echo "Smoke test passed."
