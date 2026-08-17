#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]] || [[ ! "$2" =~ ^[7-9][0-9]*$ ]] || [[ "$3" != "PRUNE_ENCRYPTED_BACKUPS" ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
BACKUP_ROOT="$(realpath -- "$DEPLOY_ROOT/backups")"
KEEP_COUNT="$2"
mapfile -t BACKUPS < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort --numeric-sort --reverse | cut -d' ' -f2-)

for ((INDEX = KEEP_COUNT; INDEX < ${#BACKUPS[@]}; INDEX += 1)); do
  TARGET="$(realpath -- "${BACKUPS[$INDEX]}")"
  case "$TARGET/" in
    "$BACKUP_ROOT/"*) ;;
    *) exit 65 ;;
  esac
  if [[ ! -f "$TARGET/metadata.env" ]] || [[ ! -f "$TARGET/SHA256SUMS" ]] || [[ ! -f "$TARGET/mysql.sql.gz.age" ]] || [[ ! -f "$TARGET/server-state.tar.gz.age" ]]; then
    exit 66
  fi
  rm -rf --one-file-system -- "$TARGET"
done
