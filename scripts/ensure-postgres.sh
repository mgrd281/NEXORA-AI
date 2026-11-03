#!/usr/bin/env bash
# Starts the local PostgreSQL 16 cluster if it is not running (dev containers only).
set -euo pipefail
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  pg_ctlcluster 16 main start 2>/dev/null || service postgresql start
  for _ in $(seq 1 20); do pg_isready -h localhost -p 5432 -q && break; sleep 0.5; done
fi
pg_isready -h localhost -p 5432
