#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
BACKUP_DIRECTORY="$(realpath -- "$2")"
IDENTITY_FILE="$(realpath -- "$3")"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/compose-secrets.env"
RUNTIME_ENVIRONMENT="$CURRENT_DIRECTORY/runtime.env"
WORK_DIRECTORY=""
CONTAINER_NAME=""

case "$BACKUP_DIRECTORY/" in
  "$DEPLOY_ROOT/backups/"*) ;;
  *) exit 65 ;;
esac
if [[ ! -f "$IDENTITY_FILE" ]] || find "$IDENTITY_FILE" -perm /077 -print -quit | grep -q .; then
  exit 66
fi

compose() {
  docker compose \
    --project-directory "$CURRENT_DIRECTORY" \
    --file "$CURRENT_DIRECTORY/compose.yml" \
    --env-file "$SHARED_ENVIRONMENT" \
    --env-file "$RUNTIME_ENVIRONMENT" \
    "$@"
}

cleanup() {
  if [[ -n "$CONTAINER_NAME" ]]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORK_DIRECTORY" ]] && [[ -d "$WORK_DIRECTORY" ]]; then
    rm -rf --one-file-system -- "$WORK_DIRECTORY"
  fi
}

trap cleanup EXIT
BACKUP_FORMAT="$(sed -n 's/^BACKUP_FORMAT=//p' "$BACKUP_DIRECTORY/metadata.env")"
if [[ "$BACKUP_FORMAT" == "1" ]]; then
  EXPECTED_FILE_COUNT=3
elif [[ "$BACKUP_FORMAT" == "2" ]]; then
  EXPECTED_FILE_COUNT=4
else
  exit 67
fi
[[ "$(wc -l < "$BACKUP_DIRECTORY/SHA256SUMS")" -eq "$EXPECTED_FILE_COUNT" ]]
while read -r FILE_SHA256 FILE_NAME; do
  FILE_NAME="${FILE_NAME#\*}"
  [[ "$FILE_NAME" =~ ^(compose-secrets\.env\.age|metadata\.env|mysql\.sql\.gz\.age|server-state\.tar\.gz\.age)$ ]]
  [[ "$(sha256sum "$BACKUP_DIRECTORY/$FILE_NAME" | cut -d' ' -f1)" == "$FILE_SHA256" ]]
done < "$BACKUP_DIRECTORY/SHA256SUMS"
SCHEMA_VERSION="$(sed -n 's/^SCHEMA_VERSION=//p' "$BACKUP_DIRECTORY/metadata.env")"
RECOVERY_POINT_ID="$(sed -n 's/^RECOVERY_POINT_ID=//p' "$BACKUP_DIRECTORY/metadata.env")"
if [[ ! "$SCHEMA_VERSION" =~ ^[0-9]{4}$ ]] || [[ ! "$RECOVERY_POINT_ID" =~ ^[A-Za-z0-9._-]{8,100}$ ]]; then
  exit 67
fi

WORK_DIRECTORY="$(mktemp -d)"
chmod 0700 "$WORK_DIRECTORY"
age --decrypt --identity "$IDENTITY_FILE" --output "$WORK_DIRECTORY/mysql.sql.gz" "$BACKUP_DIRECTORY/mysql.sql.gz.age"
age --decrypt --identity "$IDENTITY_FILE" --output "$WORK_DIRECTORY/server-state.tar.gz" "$BACKUP_DIRECTORY/server-state.tar.gz.age"
if [[ "$BACKUP_FORMAT" == "2" ]]; then
  age --decrypt --identity "$IDENTITY_FILE" --output "$WORK_DIRECTORY/compose-secrets.env" "$BACKUP_DIRECTORY/compose-secrets.env.age"
  [[ "$(grep -Ec '^(MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD|REDIS_PASSWORD)=[a-f0-9]{64}$' "$WORK_DIRECTORY/compose-secrets.env")" -eq 3 ]]
  [[ "$(wc -l < "$WORK_DIRECTORY/compose-secrets.env")" -eq 3 ]]
fi
gzip --test "$WORK_DIRECTORY/mysql.sql.gz"
gzip --test "$WORK_DIRECTORY/server-state.tar.gz"
if tar -tzf "$WORK_DIRECTORY/server-state.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  exit 67
fi
tar -tzf "$WORK_DIRECTORY/server-state.tar.gz" | grep -Eq '(^|/)setup-state\.json$'

MYSQL_CONTAINER="$(compose ps -q remote-control-hub-mysql)"
MYSQL_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$MYSQL_CONTAINER")"
CONTAINER_NAME="rch-restore-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
RESTORE_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
docker run --detach --rm --name "$CONTAINER_NAME" \
  --env MYSQL_DATABASE=restore_validation \
  --env MYSQL_ROOT_PASSWORD="$RESTORE_PASSWORD" \
  --tmpfs /var/lib/mysql:rw,noexec,nosuid,size=2g \
  "$MYSQL_IMAGE" >/dev/null

for _ in {1..60}; do
  if docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$CONTAINER_NAME" mysqladmin ping --host=127.0.0.1 --user=root --silent >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$CONTAINER_NAME" mysqladmin ping --host=127.0.0.1 --user=root --silent >/dev/null
gzip --decompress --stdout "$WORK_DIRECTORY/mysql.sql.gz" \
  | docker exec --interactive --env MYSQL_PWD="$RESTORE_PASSWORD" "$CONTAINER_NAME" mysql --user=root restore_validation
TABLE_COUNT="$(docker exec --env MYSQL_PWD="$RESTORE_PASSWORD" "$CONTAINER_NAME" mysql --batch --skip-column-names --user=root --execute "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='restore_validation';")"
if [[ ! "$TABLE_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  exit 67
fi
printf '%s %s %s\n' "$RECOVERY_POINT_ID" "$SCHEMA_VERSION" "$TABLE_COUNT"
