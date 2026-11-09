#!/usr/bin/env bash
# (Re)creates the UAT database from the openIMIS demo dataset, next to the dev
# database in the dev-tools Postgres container, then migrates it:
#   1. CREATE DATABASE $UAT_DB_NAME, loaded with the init scripts the published
#      openimis-pgsql image runs on first start (schema + demo_db.sql); with --empty,
#      without demo_db.sql: only Admin and the reference lists, which is enough for the
#      suite since every spec relies on the UAT baseline (scripts/baseline.mjs), not on
#      demo records;
#   2. Django migrations, with backend/.env and the database name overridden;
#   3. Admin gets the Django superuser flag: since core stopped deriving it from the
#      legacy IsSystem role, the demo Admin cannot open /api/admin, which the suite
#      uses to pin module configuration and clear login lockouts.
#
# Environment: UAT_DB_NAME (default demo_imis, empty_imis with --empty),
# DB_CONTAINER (openimis-dev-tools-db-1), PSQL_USER (IMISuser).
# Options: --force drops an existing database first; --empty skips the demo dataset.
set -euo pipefail

force=false
empty=false
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    --empty) empty=true ;;
    *) echo "Unknown option $arg (expected --force, --empty)" >&2; exit 1 ;;
  esac
done

UAT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_TOOLS="$(cd "$UAT_DIR/.." && pwd)"
if $empty; then DB="${UAT_DB_NAME:-empty_imis}"; else DB="${UAT_DB_NAME:-demo_imis}"; fi
CONTAINER="${DB_CONTAINER:-openimis-dev-tools-db-1}"
PGUSER="${PSQL_USER:-IMISuser}"
psql_in() { docker exec -i "$CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"; }

if [ "$DB" = "${PSQL_DB_NAME:-test_imis}" ] || [ "$DB" = test_imis ]; then
  echo "Refusing to recreate the dev database '$DB'." >&2
  exit 1
fi

exists=$(psql_in -d postgres -Atc "select 1 from pg_database where datname = '$DB'")
if [ -n "$exists" ]; then
  if ! $force; then
    echo "Database $DB already exists; pass --force to recreate it." >&2
    exit 1
  fi
  psql_in -d postgres -c "DROP DATABASE \"$DB\" WITH (FORCE);"
fi

psql_in -d postgres -c "CREATE DATABASE \"$DB\" OWNER \"$PGUSER\";"
docker exec "$CONTAINER" sh -c '
  set -e
  for f in $(ls /docker-entrypoint-initdb.d/*.sql | sort); do
    if [ "$3" = true ] && [ "$(basename "$f")" = demo_db.sql ]; then echo "skipping $f"; continue; fi
    echo "loading $f"
    psql -U "$1" -d "$2" -q -v ON_ERROR_STOP=1 -f "$f" > /tmp/uat_db_load.log 2>&1 || { tail -5 /tmp/uat_db_load.log; exit 1; }
  done' sh "$PGUSER" "$DB" "$empty"

(
  cd "$DEV_TOOLS/backend/openIMIS"
  PSQL_DB_NAME="$DB" DB_NAME="$DB" DB_DEFAULT=psql \
    ../.venv/bin/python -m dotenv -f ../.env run --no-override \
    ../.venv/bin/python manage.py migrate --noinput
)

psql_in -d "$DB" -c "UPDATE \"core_User\" SET is_superuser = true WHERE username = 'Admin';"
echo "Database $DB ready."
