#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]] || [[ ! "$3" =~ ^[A-Za-z0-9._-]{8,100}$ ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
BACKUP_ROOT="$(realpath -m -- "$2")"
RECOVERY_POINT_ID="$3"
RECIPIENT_FILE="$(realpath -- "$4")"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/compose-secrets.env"
RUNTIME_ENVIRONMENT="$CURRENT_DIRECTORY/runtime.env"
SCHEMA_VERSION="$(sed -n 's/.*"schemaVersion":"\([^"]*\)".*/\1/p' "$CURRENT_DIRECTORY/deployment.json")"
SERVER_STOPPED=0
WORK_DIRECTORY=""

if [[ "$BACKUP_ROOT" != "$DEPLOY_ROOT/backups" ]] || [[ ! "$SCHEMA_VERSION" =~ ^[0-9]{4}$ ]]; then
  exit 65
fi
if [[ ! -f "$SHARED_ENVIRONMENT" ]] || find "$SHARED_ENVIRONMENT" -perm /077 -print -quit | grep -q .; then
  exit 66
fi
if [[ ! -f "$RECIPIENT_FILE" ]] || find "$RECIPIENT_FILE" -perm /077 -print -quit | grep -q .; then
  exit 66
fi
AGE_RECIPIENT="$(tr -d '\r\n' < "$RECIPIENT_FILE")"
if [[ ! "$AGE_RECIPIENT" =~ ^age1[0-9a-z]{50,100}$ ]]; then
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
  if [[ $SERVER_STOPPED -eq 1 ]]; then
    compose up --detach --wait --wait-timeout 120 remote-control-hub-server >/dev/null
  fi
  if [[ -n "$WORK_DIRECTORY" ]] && [[ -d "$WORK_DIRECTORY" ]]; then
    rm -rf --one-file-system -- "$WORK_DIRECTORY"
  fi
}

trap cleanup EXIT
mkdir -p -- "$BACKUP_ROOT" "$DEPLOY_ROOT/locks"
exec 9> "$DEPLOY_ROOT/locks/backup.lock"
flock --exclusive --nonblock 9
WORK_DIRECTORY="$(mktemp -d --tmpdir="$BACKUP_ROOT" .backup.XXXXXXXX)"
chmod 0700 "$WORK_DIRECTORY"

compose stop remote-control-hub-server >/dev/null
SERVER_STOPPED=1
compose exec -T remote-control-hub-mysql sh -eu -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump --single-transaction --routines --events --hex-blob --set-gtid-purged=OFF --default-character-set=utf8mb4 --user="$MYSQL_USER" "$MYSQL_DATABASE"' \
  | gzip --best > "$WORK_DIRECTORY/mysql.sql.gz"
compose run --rm --no-deps --entrypoint tar remote-control-hub-server --numeric-owner -cf - -C /var/lib/remote-control-hub . \
  | gzip --best > "$WORK_DIRECTORY/server-state.tar.gz"

age --encrypt --recipient "$AGE_RECIPIENT" --output "$WORK_DIRECTORY/mysql.sql.gz.age" "$WORK_DIRECTORY/mysql.sql.gz"
age --encrypt --recipient "$AGE_RECIPIENT" --output "$WORK_DIRECTORY/server-state.tar.gz.age" "$WORK_DIRECTORY/server-state.tar.gz"
age --encrypt --recipient "$AGE_RECIPIENT" --output "$WORK_DIRECTORY/compose-secrets.env.age" "$SHARED_ENVIRONMENT"
rm -f -- "$WORK_DIRECTORY/mysql.sql.gz" "$WORK_DIRECTORY/server-state.tar.gz"

CREATED_AT="$(date --utc +'%Y-%m-%dT%H:%M:%SZ')"
COMMIT_SHA="$(sed -n 's/.*"commit":"\([a-f0-9]*\)".*/\1/p' "$CURRENT_DIRECTORY/deployment.json")"
printf 'BACKUP_FORMAT=2\nRECOVERY_POINT_ID=%s\nCREATED_AT=%s\nCOMMIT_SHA=%s\nSCHEMA_VERSION=%s\n' \
  "$RECOVERY_POINT_ID" "$CREATED_AT" "$COMMIT_SHA" "$SCHEMA_VERSION" \
  > "$WORK_DIRECTORY/metadata.env"
: > "$WORK_DIRECTORY/SHA256SUMS"
for FILE_NAME in compose-secrets.env.age metadata.env mysql.sql.gz.age server-state.tar.gz.age; do
  FILE_SHA256="$(sha256sum "$WORK_DIRECTORY/$FILE_NAME" | cut -d' ' -f1)"
  printf '%s  %s\n' "$FILE_SHA256" "$FILE_NAME" >> "$WORK_DIRECTORY/SHA256SUMS"
done

compose up --detach --wait --wait-timeout 120 remote-control-hub-server >/dev/null
SERVER_STOPPED=0
FINAL_DIRECTORY="$BACKUP_ROOT/$(date --utc +'%Y%m%dT%H%M%SZ')-$RECOVERY_POINT_ID"
if [[ -e "$FINAL_DIRECTORY" ]]; then
  exit 73
fi
mv -- "$WORK_DIRECTORY" "$FINAL_DIRECTORY"
WORK_DIRECTORY=""
printf '%s\n' "$FINAL_DIRECTORY"
