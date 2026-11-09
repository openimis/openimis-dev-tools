#!/usr/bin/env bash
# Starts a UAT stack next to the regular dev stack (:3000 -> :8000), on the demo
# dataset database:
#   backend  :8001  (backend/.env, with the database names overridden)
#   frontend :3001  (same assembly, /api proxied to :8001; see vite.uat.config.mjs)
#            built for production and served by `vite preview`, like a deployed
#            instance (~2 min build; a page loads in ~1 s instead of 10-20 s from the
#            dev server). UAT_FRONTEND_MODE=dev serves the sources instead (picks up
#            module edits without a rebuild).
# Then run the suite with:  node scripts/run-uat.mjs --base-url http://localhost:3001
#
# Environment: UAT_DB_NAME (default demo_imis), UAT_BACKEND_PORT (8001),
# UAT_FRONTEND_PORT (3001), UAT_FRONTEND_MODE (build | dev, default build).
# Logs go to uat-test/logs/. Ctrl-C stops both servers.
set -euo pipefail

UAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_TOOLS="$(cd "$UAT_DIR/.." && pwd)"
DB_NAME_UAT="${UAT_DB_NAME:-demo_imis}"
BACKEND_PORT="${UAT_BACKEND_PORT:-8001}"
FRONTEND_PORT="${UAT_FRONTEND_PORT:-3001}"
FRONTEND_MODE="${UAT_FRONTEND_MODE:-build}"
LOG_DIR="$UAT_DIR/logs"
mkdir -p "$LOG_DIR"

pids=()
cleanup() { [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Variables already in the environment win over backend/.env (--no-override), as
# with the VS Code launch configuration that injects the same file.
(
  cd "$DEV_TOOLS/backend/openIMIS"
  PSQL_DB_NAME="$DB_NAME_UAT" DB_NAME="$DB_NAME_UAT" DB_DEFAULT=psql \
    ../.venv/bin/python -m dotenv -f ../.env run --no-override \
    ../.venv/bin/python manage.py runserver "0.0.0.0:$BACKEND_PORT" --noreload
) >"$LOG_DIR/backend.log" 2>&1 &
pids+=($!)

export UAT_FRONTEND_PORT="$FRONTEND_PORT" UAT_API_TARGET="http://localhost:$BACKEND_PORT"
if [ "$FRONTEND_MODE" = build ]; then
  echo "Building the frontend (log: $LOG_DIR/build.log)..."
  (cd "$DEV_TOOLS/frontend" && npx vite build --config "$UAT_DIR/vite.uat.config.mjs") >"$LOG_DIR/build.log" 2>&1 \
    || { echo "Frontend build failed; see $LOG_DIR/build.log" >&2; exit 1; }
  vite_cmd=(npx vite preview --config "$UAT_DIR/vite.uat.config.mjs")
else
  vite_cmd=(npx vite --config "$UAT_DIR/vite.uat.config.mjs")
fi
(cd "$DEV_TOOLS/frontend" && "${vite_cmd[@]}") >"$LOG_DIR/frontend.log" 2>&1 &
pids+=($!)

echo "Waiting for the UAT stack (logs in $LOG_DIR)..."
for _ in $(seq 1 100); do
  be=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"query":"{ __typename }"}' "http://localhost:$BACKEND_PORT/api/graphql" || true)
  fe=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$FRONTEND_PORT/front/" || true)
  if [ "$be" = 200 ] && [ "$fe" = 200 ]; then
    echo "UAT stack ready: http://localhost:$FRONTEND_PORT/front/ (backend :$BACKEND_PORT, database $DB_NAME_UAT)"
    wait
    exit 0
  fi
  sleep 3
done
echo "UAT stack did not start; see $LOG_DIR" >&2
exit 1
