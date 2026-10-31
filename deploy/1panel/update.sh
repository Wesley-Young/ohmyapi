#!/usr/bin/env bash
# Deploy a revision of ohmyapi with the compose project in this directory.
#
#   deploy/1panel/update.sh [git ref]    (default: origin/main; an older commit rolls back)
#
# The update runs detached, so a dropped SSH session does not interrupt it; output is appended to run/update.log.
# The running container is replaced only after the image is built, the database is backed up and migrated, and the
# new image accepts the configuration and the migrated schema.

# The braces make bash read the whole script before running it, since the checkout below may replace this file.
{
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
run_dir=$here/run
log=$run_dir/update.log
status_file=$run_dir/status
backup_dir=${OHMYAPI_BACKUP_DIR:-/opt/1panel/backup/ohmyapi}
keep_backups=${OHMYAPI_KEEP_BACKUPS:-14}
# Previous images kept for rollback, besides the deployed one.
keep_images=2

mkdir -p "$run_dir"

if [[ ${OHMYAPI_UPDATE_DETACHED:-} != 1 ]]; then
  rm -f "$status_file"
  offset=$(stat -c %s "$log" 2>/dev/null || echo 0)
  OHMYAPI_UPDATE_DETACHED=1 setsid nohup "$here/$(basename "$0")" "$@" >>"$log" 2>&1 </dev/null &
  pid=$!
  echo "Updating in the background (pid $pid), logging to $log. Ctrl-C stops watching, not the update."
  tail -c +$((offset + 1)) -F --pid="$pid" "$log" 2>/dev/null
  exit "$(cat "$status_file" 2>/dev/null || echo 1)"
fi

step() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() {
  echo "$*" >&2
  exit 1
}

exec 9>"$run_dir/lock"
flock -n 9 || fail 'Another update is running'

cd "$here"
repo=$(git rev-parse --show-toplevel)
previous=$(git -C "$repo" rev-parse HEAD)
switched=0

# shellcheck disable=SC2317 # Invoked by the EXIT trap.
finish() {
  local code=$?
  if ((code != 0)) && ((switched == 0)); then
    git -C "$repo" checkout --quiet --detach "$previous" || true
    echo 'Update failed; the running version was not changed.' >&2
  fi
  step "Finished with status $code"
  echo "$code" >"$status_file"
}
trap finish EXIT

ref=${1:-origin/main}
step "Fetching $ref"
[[ -z $(git -C "$repo" status --porcelain --untracked-files=no) ]] || fail 'Tracked files have local changes'
git -C "$repo" fetch --quiet origin
target=$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}") || fail "Unknown ref: $ref"
tag=$(git -C "$repo" rev-parse --short=7 "$target")
current_tag=$(sed -n 's/^OHMYAPI_IMAGE_TAG=//p' .env 2>/dev/null || true)
echo "Deployed: ${current_tag:-none}, target: $tag $(git -C "$repo" log -1 --format=%s "$target")"
git -C "$repo" checkout --quiet --detach "$target"
export OHMYAPI_IMAGE_TAG=$tag

if docker image inspect "ohmyapi:$tag" >/dev/null 2>&1; then
  step "Image ohmyapi:$tag already exists"
else
  step "Building ohmyapi:$tag"
  docker compose build --progress=plain app
fi

step 'Checking the database'
docker compose up -d --wait db
initialized=$(docker compose exec -T db psql -U ohmyapi -d ohmyapi -Atc \
  "select to_regclass('drizzle.__drizzle_migrations') is not null")
[[ $initialized == t ]] || fail 'The database has no ohmyapi schema; restore the data before updating'

step 'Backing up the database'
mkdir -p "$backup_dir"
backup=$backup_dir/ohmyapi-$(date +%Y%m%d-%H%M%S)-${current_tag:-none}.dump
docker compose exec -T db pg_dump -U ohmyapi -Fc ohmyapi >"$backup.partial"
mv "$backup.partial" "$backup"
echo "$backup ($(du -h "$backup" | cut -f1))"
find "$backup_dir" -maxdepth 1 -name 'ohmyapi-*.dump' -printf '%T@ %p\n' | sort -rn | tail -n +$((keep_backups + 1)) |
  cut -d' ' -f2- | xargs -r rm --

step 'Migrating the database'
docker compose run --rm --no-deps -T app node --conditions=@ohmyapi/source daemon/src/cli/migrate.ts

# An older revision fails here when the database already has newer migrations; restore a backup to roll back past them.
step 'Checking the new image against the configuration and schema'
docker compose run --rm --no-deps -T app node --conditions=@ohmyapi/source --input-type=module -e "
  process.env.NODE_ENV = 'production';
  const { readDatabaseConfig, validateProductionConfig } = await import('/app/daemon/src/config.ts');
  const { createDatabase } = await import('/app/daemon/src/plugins/database/client.ts');
  const { assertMigrationsCurrent } = await import('/app/daemon/src/plugins/database/migrate.ts');
  validateProductionConfig();
  const { db, pool } = createDatabase(readDatabaseConfig());
  try {
    await assertMigrationsCurrent(db);
  } finally {
    await pool.end();
  }
  console.info('Configuration and schema are compatible');
"

step "Switching to ohmyapi:$tag (the old container finishes its requests first, up to 15 minutes)"
if grep -q '^OHMYAPI_IMAGE_TAG=' .env 2>/dev/null; then
  sed -i "s/^OHMYAPI_IMAGE_TAG=.*/OHMYAPI_IMAGE_TAG=$tag/" .env
else
  echo "OHMYAPI_IMAGE_TAG=$tag" >>.env
fi
switched=1
if ! docker compose up -d --wait app; then
  docker compose logs --tail=50 app || true
  fail "ohmyapi:$tag did not become healthy; roll back with: $here/update.sh ${previous:0:7}"
fi
curl -fsS http://127.0.0.1:39999/api/ready >/dev/null || fail 'The new container is healthy but not reachable on port 39999'

step 'Removing old images'
docker image ls ohmyapi --format '{{.Tag}}' | grep -vx "$tag" | tail -n +$((keep_images + 1)) |
  xargs -r -I{} docker image rm "ohmyapi:{}" || true

step "ohmyapi:$tag is running (previous: ${current_tag:-none})"
exit
}
