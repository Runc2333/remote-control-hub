#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
TARGET_DIRECTORY="$(realpath -- "$2")"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/production.env"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"

case "$TARGET_DIRECTORY/" in
  "$DEPLOY_ROOT/releases/"*) ;;
  *) exit 65 ;;
esac

if [[ ! -f "$TARGET_DIRECTORY/deployment.json" ]] || [[ ! -f "$TARGET_DIRECTORY/runtime.env" ]]; then
  exit 66
fi
CURRENT_SCHEMA="$(sed -n 's/.*"schemaVersion":"\([^"]*\)".*/\1/p' "$CURRENT_DIRECTORY/deployment.json")"
TARGET_MAXIMUM_SCHEMA="$(sed -n 's/^MAXIMUM_SCHEMA=//p' "$TARGET_DIRECTORY/release.env")"
if [[ ! "$CURRENT_SCHEMA" =~ ^[0-9]{4}$ ]] || [[ ! "$TARGET_MAXIMUM_SCHEMA" =~ ^[0-9]{4}$ ]] || [[ "$(printf '%s\n%s\n' "$CURRENT_SCHEMA" "$TARGET_MAXIMUM_SCHEMA" | sort --version-sort | tail -n 1)" != "$TARGET_MAXIMUM_SCHEMA" ]]; then
  exit 67
fi

docker compose \
  --project-directory "$TARGET_DIRECTORY" \
  --file "$TARGET_DIRECTORY/compose.yml" \
  --env-file "$SHARED_ENVIRONMENT" \
  --env-file "$TARGET_DIRECTORY/runtime.env" \
  config --quiet
docker compose \
  --project-directory "$TARGET_DIRECTORY" \
  --file "$TARGET_DIRECTORY/compose.yml" \
  --env-file "$SHARED_ENVIRONMENT" \
  --env-file "$TARGET_DIRECTORY/runtime.env" \
  up --detach --wait --wait-timeout 120
ln -sfn -- "$TARGET_DIRECTORY" "$DEPLOY_ROOT/current.next"
mv -Tf -- "$DEPLOY_ROOT/current.next" "$DEPLOY_ROOT/current"
