#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]] || [[ ! "$2" =~ ^[3-9][0-9]*$ ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
RELEASES_DIRECTORY="$DEPLOY_ROOT/releases"
KEEP_COUNT="$2"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
mapfile -t RELEASES < <(find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort --numeric-sort --reverse | cut -d' ' -f2-)

for ((index = KEEP_COUNT; index < ${#RELEASES[@]}; index += 1)); do
  TARGET="$(realpath -- "${RELEASES[$index]}")"
  case "$TARGET/" in
    "$RELEASES_DIRECTORY/"*) ;;
    *) exit 65 ;;
  esac
  if [[ "$TARGET" != "$CURRENT_DIRECTORY" ]]; then
    rm -rf --one-file-system -- "$TARGET"
  fi
done
