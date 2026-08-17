#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]] || [[ ! "$3" =~ ^[a-f0-9]{64}$ ]] || [[ "$4" != "REPLACE_GEOIP_DATABASE" ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
CANDIDATE="$(realpath -- "$2")"
EXPECTED_SHA256="$3"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/production.env"
RUNTIME_ENVIRONMENT="$CURRENT_DIRECTORY/runtime.env"
TARGET="$(sed -n 's/^GEOIP_DATABASE_HOST=//p' "$SHARED_ENVIRONMENT")"

if [[ ! -f "$CANDIDATE" ]] || [[ "$(sha256sum "$CANDIDATE" | cut -d' ' -f1)" != "$EXPECTED_SHA256" ]]; then
  exit 66
fi
if [[ -z "$TARGET" ]] || [[ "$TARGET" != /* ]]; then
  exit 66
fi
TARGET_DIRECTORY="$(realpath -m -- "$(dirname -- "$TARGET")")"
mkdir -p -- "$TARGET_DIRECTORY" "$DEPLOY_ROOT/locks"
TARGET="$(realpath -m -- "$TARGET")"
case "$TARGET/" in
  "$TARGET_DIRECTORY/"*) ;;
  *) exit 65 ;;
esac

compose() {
  docker compose \
    --project-directory "$CURRENT_DIRECTORY" \
    --file "$CURRENT_DIRECTORY/compose.yml" \
    --env-file "$SHARED_ENVIRONMENT" \
    --env-file "$RUNTIME_ENVIRONMENT" \
    "$@"
}

exec 9> "$DEPLOY_ROOT/locks/geoip.lock"
flock --exclusive --nonblock 9
SERVER_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(compose ps -q server)")"
docker run --rm --volume "$CANDIDATE:/tmp/candidate.mmdb:ro" --entrypoint node "$SERVER_IMAGE" \
  -e "require('maxmind').open('/tmp/candidate.mmdb').then(reader=>{const metadata=reader.metadata;if(!metadata.databaseType||!metadata.buildEpoch)process.exit(1);process.stdout.write(metadata.databaseType+' '+metadata.buildEpoch.toISOString())}).catch(()=>process.exit(1))"

STAGED="$TARGET_DIRECTORY/.$(basename -- "$TARGET").new"
PREVIOUS="$TARGET_DIRECTORY/.$(basename -- "$TARGET").previous"
install --mode=0644 -- "$CANDIDATE" "$STAGED"
sync -f "$STAGED"
if [[ -f "$TARGET" ]]; then
  mv -f -- "$TARGET" "$PREVIOUS"
fi
mv -f -- "$STAGED" "$TARGET"
sync -f "$TARGET_DIRECTORY"
compose restart server >/dev/null
compose up --detach --wait --wait-timeout 120 server >/dev/null
printf '%s\n' "$EXPECTED_SHA256"
