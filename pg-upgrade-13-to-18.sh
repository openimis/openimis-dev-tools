#!/usr/bin/env bash
# Upgrade the PostgreSQL data volume of an openIMIS compose stack from an old
# major (13) to the major of the image the compose file now references
# (openimis-pgsql:26.10 and later ship PostgreSQL 18).
#
# Method: dump and restore, not pg_upgrade. The databases are small, and a
# logical dump also handles the different libc/collation builds between images.
#
#   1. dump every database from the old cluster with the NEW pg_dumpall
#   2. docker compose down (the whole stack)
#   3. copy the old volume to <volume>_pg<old> (rollback copy), empty the volume
#   4. switch the compose mount from /var/lib/postgresql/data to
#      /var/lib/postgresql (layout required by the postgres 18+ images)
#   5. init an empty PG18 cluster (no openIMIS init scripts), restore the dump,
#      reset the app user password to SCRAM (PG13 stored md5 hashes), analyze
#   6. compare exact row counts of every table, old vs new
#   7. docker compose up -d and check a password login over TCP
#
# Usage: pg-upgrade-13-to-18.sh [--check] [-y] <compose-dir>
#   --check  only run the preflight checks and print the plan, change nothing
#   -y       do not ask for confirmation
# Env:    DB_SERVICE (default db), OLD_IMAGE (image able to run the old data),
#         BACKUP_ROOT (default ~/pg-upgrade-backups)
set -euo pipefail

CHECK_ONLY=0
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    -y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) break ;;
  esac
done
[[ $# -eq 1 ]] || { echo "usage: $0 [--check] [-y] <compose-dir>" >&2; exit 2; }

COMPOSE_DIR=$(cd "$1" && pwd)
SERVICE=${DB_SERVICE:-db}
BACKUP_ROOT=${BACKUP_ROOT:-$HOME/pg-upgrade-backups}
STAGE=preflight

log() { printf '\n[%s] %s\n' "$(date +%T)" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

cd "$COMPOSE_DIR"
command -v jq >/dev/null || die "jq is required"

cfg=$(docker compose config --format json 2>/dev/null) || die "docker compose config failed in $COMPOSE_DIR"
PROJECT=$(jq -r '.name' <<<"$cfg")
jq -e --arg s "$SERVICE" '.services[$s]' <<<"$cfg" >/dev/null || die "service '$SERVICE' not found"

env_of() { jq -r --arg s "$SERVICE" --arg k "$1" '.services[$s].environment[$k] // empty' <<<"$cfg"; }
DB_USER=$(env_of POSTGRES_USER)
DB_PASSWORD=$(env_of POSTGRES_PASSWORD)
DB_NAME=$(env_of POSTGRES_DB)
[[ -n "$DB_USER" && -n "$DB_PASSWORD" ]] || die "POSTGRES_USER/POSTGRES_PASSWORD not set on service $SERVICE"

# Image the compose file now references; a build-only service is tagged <project>-<service>.
NEW_IMAGE=$(jq -r --arg s "$SERVICE" '.services[$s].image // empty' <<<"$cfg")
[[ -n "$NEW_IMAGE" ]] || NEW_IMAGE="$PROJECT-$SERVICE"
if ! docker image inspect "$NEW_IMAGE" >/dev/null 2>&1; then
  log "Image $NEW_IMAGE not present, pulling/building it"
  if jq -e --arg s "$SERVICE" '.services[$s].build' <<<"$cfg" >/dev/null; then
    docker compose build "$SERVICE"
  else
    docker compose pull "$SERVICE"
  fi
fi
pg_major_of() { docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^PG_MAJOR=//p'; }
NEW_MAJOR=$(pg_major_of "$NEW_IMAGE")
[[ -n "$NEW_MAJOR" && "$NEW_MAJOR" -ge 18 ]] || die "$NEW_IMAGE is PostgreSQL '${NEW_MAJOR:-?}', expected 18+ (set DB_TAG in .env first)"

VOL_KEY=$(jq -r --arg s "$SERVICE" '[.services[$s].volumes[]? | select(.type=="volume" and (.target|startswith("/var/lib/postgresql")))][0].source // empty' <<<"$cfg")
VOL_TARGET=$(jq -r --arg s "$SERVICE" '[.services[$s].volumes[]? | select(.type=="volume" and (.target|startswith("/var/lib/postgresql")))][0].target // empty' <<<"$cfg")
[[ -n "$VOL_KEY" ]] || die "no named volume mounted under /var/lib/postgresql on service $SERVICE"
VOLUME=$(jq -r --arg k "$VOL_KEY" '.volumes[$k].name // empty' <<<"$cfg")
[[ -n "$VOLUME" ]] || VOLUME="${PROJECT}_${VOL_KEY}"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume $VOLUME does not exist"

# Read the data layout with the new image itself, so no extra image is pulled.
vol_sh() { docker run --rm -v "$VOLUME:/v:ro" --entrypoint sh "$NEW_IMAGE" -c "$1"; }
if vol_sh "test -f /v/$NEW_MAJOR/docker/PG_VERSION"; then
  echo "Volume $VOLUME already holds a PostgreSQL $NEW_MAJOR cluster ($NEW_MAJOR/docker), nothing to do."
  [[ "$VOL_TARGET" == /var/lib/postgresql ]] || echo "WARNING: the compose mount is still $VOL_TARGET, it must be /var/lib/postgresql"
  exit 0
fi
OLD_MAJOR=$(vol_sh 'cat /v/PG_VERSION 2>/dev/null' || true)
[[ -n "$OLD_MAJOR" ]] || die "no PG_VERSION at the root of volume $VOLUME"
[[ "$OLD_MAJOR" -lt "$NEW_MAJOR" ]] || die "volume is PostgreSQL $OLD_MAJOR, not older than $NEW_MAJOR"

# Image able to start the old data: the stack's current container image if it matches,
# else any local image of that major, else stock postgres. Fetched now, before anything is stopped.
if [[ -z "${OLD_IMAGE:-}" ]]; then
  cur=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=$SERVICE" --format '{{.Image}}' | head -1)
  if [[ -n "$cur" ]] && [[ "$(pg_major_of "$cur" 2>/dev/null)" == "$OLD_MAJOR" ]]; then
    OLD_IMAGE=$cur
  else
    for img in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E 'openimis-pgsql|postgres' | grep -v '<none>'); do
      if [[ "$(pg_major_of "$img" 2>/dev/null)" == "$OLD_MAJOR" ]]; then OLD_IMAGE=$img; break; fi
    done
    OLD_IMAGE=${OLD_IMAGE:-public.ecr.aws/docker/library/postgres:${OLD_MAJOR}-alpine}
  fi
fi
docker image inspect "$OLD_IMAGE" >/dev/null 2>&1 || docker pull "$OLD_IMAGE" >/dev/null \
  || die "cannot pull $OLD_IMAGE, set OLD_IMAGE to a local PostgreSQL $OLD_MAJOR image"
[[ "$(pg_major_of "$OLD_IMAGE")" == "$OLD_MAJOR" ]] || die "$OLD_IMAGE is not PostgreSQL $OLD_MAJOR"

BACKUP_VOLUME="${VOLUME}_pg${OLD_MAJOR}"
docker volume inspect "$BACKUP_VOLUME" >/dev/null 2>&1 && die "backup volume $BACKUP_VOLUME already exists (previous run?)"

# Compose files that mount the volume at the old path.
mapfile -t MOUNT_FILES < <(grep -lE "^[[:space:]]*-[[:space:]]*[\"']?${VOL_KEY}:/var/lib/postgresql/data[\"']?[[:space:]]*$" ./*.yml ./*.yaml 2>/dev/null || true)
if [[ "$VOL_TARGET" == /var/lib/postgresql/data && ${#MOUNT_FILES[@]} -eq 0 ]]; then
  die "cannot find the line '- ${VOL_KEY}:/var/lib/postgresql/data' in $COMPOSE_DIR/*.yml, patch it by hand"
fi

TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/$PROJECT-$TS"
OLD_C="pgupg-old-$PROJECT"
NEW_C="pgupg-new-$PROJECT"

cat <<EOF
Project        : $PROJECT ($COMPOSE_DIR)
DB service     : $SERVICE  user=$DB_USER  db=$DB_NAME
Volume         : $VOLUME  (PostgreSQL $OLD_MAJOR, mounted at $VOL_TARGET)
Old image      : $OLD_IMAGE
New image      : $NEW_IMAGE  (PostgreSQL $NEW_MAJOR)
Rollback copy  : volume $BACKUP_VOLUME
Dump + logs    : $BACKUP_DIR
Compose patch  : ${MOUNT_FILES[*]:-none needed}  (${VOL_KEY}:/var/lib/postgresql/data -> ${VOL_KEY}:/var/lib/postgresql)
The whole stack is taken down with 'docker compose down' (volumes kept) and brought back up.
EOF
[[ $CHECK_ONLY -eq 1 ]] && { echo "--check: nothing changed."; exit 0; }
if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "Proceed? [y/N] " ans
  [[ "$ans" == y || "$ans" == Y ]] || exit 1
fi

on_error() {
  local rc=$?
  cat >&2 <<EOF

FAILED during stage '$STAGE' (exit $rc). Temporary containers are left for inspection:
  docker logs $OLD_C ; docker logs $NEW_C      (remove with: docker rm -f $OLD_C $NEW_C)
Dump and logs: $BACKUP_DIR
Rollback (only needed once the volume was emptied, i.e. stage >= 'move-volume'):
  cd $COMPOSE_DIR && docker compose down && docker rm -f $OLD_C $NEW_C
  docker volume rm $VOLUME && docker volume create $VOLUME
  docker run --rm -v $BACKUP_VOLUME:/from:ro -v $VOLUME:/to --entrypoint sh $NEW_IMAGE -c 'cp -a /from/. /to/'
  restore the compose files from $BACKUP_DIR, set DB_TAG back in .env, docker compose up -d
EOF
  exit "$rc"
}
trap on_error ERR

wait_ready() {  # TCP on 127.0.0.1 only answers once the entrypoint's init server is gone
  local c=$1
  for _ in $(seq 1 90); do
    docker exec "$c" pg_isready -q -h 127.0.0.1 -U "$DB_USER" -d postgres && return 0
    [[ "$(docker inspect -f '{{.State.Running}}' "$c")" == true ]] || { docker logs --tail 30 "$c"; return 1; }
    sleep 2
  done
  docker logs --tail 30 "$c"; return 1
}

# Exact row count of every table of every database, one "db|schema.table|count" line each.
row_counts() {
  local c=$1 db
  for db in $(docker exec "$c" psql -X -U "$DB_USER" -d postgres -Atc \
      "select datname from pg_database where datallowconn and not datistemplate order by 1"); do
    docker exec "$c" psql -X -U "$DB_USER" -d "$db" -Atc "
      select '$db|' || format('%I.%I', table_schema, table_name) || '|' ||
             (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I',
                     table_schema, table_name), false, true, '')))[1]::text
        from information_schema.tables
       where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
       order by 1"
  done
}

mkdir -p "$BACKUP_DIR"
cp -a "$COMPOSE_DIR"/*.yml "$BACKUP_DIR"/ 2>/dev/null || true
cp -a "$COMPOSE_DIR"/*.yaml "$BACKUP_DIR"/ 2>/dev/null || true
cp -a "$COMPOSE_DIR"/.env "$BACKUP_DIR"/env 2>/dev/null || true

STAGE=compose-down
# Only the services running now are brought back up at the end.
mapfile -t RUNNING_SERVICES < <(docker compose ps --services --status running 2>/dev/null)
printf '%s\n' "${RUNNING_SERVICES[@]}" > "$BACKUP_DIR/running-services.txt"
log "docker compose down ($PROJECT), running services: ${RUNNING_SERVICES[*]:-none}"
docker compose down

STAGE=start-old
log "Starting PostgreSQL $OLD_MAJOR on $VOLUME ($OLD_IMAGE)"
docker rm -f "$OLD_C" >/dev/null 2>&1 || true
docker run -d --name "$OLD_C" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_USER="$DB_USER" \
  -v "$VOLUME:/var/lib/postgresql/data" "$OLD_IMAGE" >/dev/null
wait_ready "$OLD_C"
docker exec "$OLD_C" psql -X -U "$DB_USER" -d postgres -Atc "select version()"

STAGE=dump
log "Counting rows in the old cluster"
row_counts "$OLD_C" > "$BACKUP_DIR/rowcounts-old.txt"
echo "$(wc -l < "$BACKUP_DIR/rowcounts-old.txt") tables"
log "pg_dumpall (PostgreSQL $NEW_MAJOR client) -> $BACKUP_DIR/dumpall.sql"
# Shares the old container's network namespace: 127.0.0.1 is 'trust' in pg_hba, no password needed.
docker run --rm --network "container:$OLD_C" --entrypoint pg_dumpall "$NEW_IMAGE" \
  -h 127.0.0.1 -U "$DB_USER" > "$BACKUP_DIR/dumpall.sql"
tail -n 5 "$BACKUP_DIR/dumpall.sql" | grep -q 'PostgreSQL database cluster dump complete' \
  || die "dump looks truncated"
ls -lh "$BACKUP_DIR/dumpall.sql"
docker rm -f "$OLD_C" >/dev/null

STAGE=move-volume
log "Copying $VOLUME -> $BACKUP_VOLUME (rollback copy), then emptying $VOLUME"
docker volume create "$BACKUP_VOLUME" >/dev/null
docker run --rm -v "$VOLUME:/from:ro" -v "$BACKUP_VOLUME:/to" --entrypoint sh "$NEW_IMAGE" -c 'cp -a /from/. /to/'
docker run --rm -v "$BACKUP_VOLUME:/v:ro" --entrypoint cat "$NEW_IMAGE" /v/PG_VERSION >/dev/null
docker volume rm "$VOLUME" >/dev/null

STAGE=patch-compose
for f in "${MOUNT_FILES[@]}"; do
  log "Patching mount in $f"
  sed -i -E "s#^([[:space:]]*-[[:space:]]*[\"']?${VOL_KEY}:)/var/lib/postgresql/data([\"']?[[:space:]]*)\$#\1/var/lib/postgresql\2#" "$f"
done
target=$(docker compose config --format json 2>/dev/null | jq -r --arg s "$SERVICE" --arg k "$VOL_KEY" \
  '.services[$s].volumes[] | select(.source==$k) | .target')
[[ "$target" == /var/lib/postgresql ]] || die "compose still mounts $VOL_KEY at '$target'"
# Lets compose recreate the volume with its own labels.
docker compose create "$SERVICE" >/dev/null 2>&1
docker volume inspect "$VOLUME" >/dev/null

STAGE=init-new
log "Initialising an empty PostgreSQL $NEW_MAJOR cluster (openIMIS init scripts disabled)"
docker rm -f "$NEW_C" >/dev/null 2>&1 || true
docker run -d --name "$NEW_C" -v "$VOLUME:/var/lib/postgresql" --tmpfs /docker-entrypoint-initdb.d \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB=postgres \
  "$NEW_IMAGE" >/dev/null
wait_ready "$NEW_C"

STAGE=restore
log "Restoring the dump (log: $BACKUP_DIR/restore.log)"
docker exec -i "$NEW_C" psql -X -q -U "$DB_USER" -d postgres -v ON_ERROR_STOP=0 \
  < "$BACKUP_DIR/dumpall.sql" > "$BACKUP_DIR/restore.log" 2>&1
# The bootstrap superuser already exists in the new cluster; that is the only expected error.
if grep -E 'ERROR:' "$BACKUP_DIR/restore.log" | grep -vF "role \"$DB_USER\" already exists"; then
  die "unexpected errors during restore, see $BACKUP_DIR/restore.log"
fi

STAGE=post-restore
log "Resetting the password of $DB_USER as SCRAM (PostgreSQL $OLD_MAJOR stored md5)"
printf 'SET password_encryption = %s;\nALTER ROLE :"u" PASSWORD :%s;\n' "'scram-sha-256'" "'pw'" \
  | docker exec -i "$NEW_C" psql -X -q -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -v u="$DB_USER" -v pw="$DB_PASSWORD"
md5_roles=$(docker exec "$NEW_C" psql -X -U "$DB_USER" -d postgres -Atc \
  "select string_agg(rolname, ', ') from pg_authid where rolpassword like 'md5%'")
[[ -z "$md5_roles" ]] || echo "WARNING: these roles still have md5 passwords and cannot log in over SCRAM: $md5_roles"
log "ANALYZE"
docker exec "$NEW_C" vacuumdb -U "$DB_USER" --all --analyze-in-stages -q

STAGE=verify
log "Comparing row counts"
row_counts "$NEW_C" > "$BACKUP_DIR/rowcounts-new.txt"
if ! diff "$BACKUP_DIR/rowcounts-old.txt" "$BACKUP_DIR/rowcounts-new.txt" > "$BACKUP_DIR/rowcounts.diff"; then
  cat "$BACKUP_DIR/rowcounts.diff"
  die "row counts differ (see $BACKUP_DIR/rowcounts.diff)"
fi
echo "identical: $(wc -l < "$BACKUP_DIR/rowcounts-new.txt") tables"
docker stop "$NEW_C" >/dev/null && docker rm "$NEW_C" >/dev/null

STAGE=compose-up
UP_SERVICES=("${RUNNING_SERVICES[@]}")
[[ " ${UP_SERVICES[*]} " == *" $SERVICE "* ]] || UP_SERVICES+=("$SERVICE")
log "docker compose up -d ${UP_SERVICES[*]}"
docker compose up -d "${UP_SERVICES[@]}"
for _ in $(seq 1 60); do
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$(docker compose ps -q "$SERVICE")" 2>/dev/null || true)
  [[ "$health" == healthy || "$health" == none ]] && break
  sleep 3
done
echo "db health: $health"
# Log in over the container's own IP, so the 'host all all all scram-sha-256' rule and the password are tested.
docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" "$SERVICE" sh -c \
  'psql -X -h "$(hostname -i | cut -d" " -f1)" -U "$POSTGRES_USER" -d "${POSTGRES_DB:-postgres}" -Atc "select version()"'

trap - ERR
cat <<EOF

Done: $PROJECT now runs PostgreSQL $NEW_MAJOR on $VOLUME.
Kept for rollback: volume $BACKUP_VOLUME, dump and compose backups in $BACKUP_DIR.
Once the stack is confirmed OK, remove them with:
  docker volume rm $BACKUP_VOLUME && rm -rf $BACKUP_DIR
EOF
