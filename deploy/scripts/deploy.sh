#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 7 ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -m -- "$1")"
RELEASE_DIRECTORY="$(realpath -- "$2")"
IMAGE_REFERENCE="$3"
COMMIT_SHA="$4"
BUNDLE_SHA256="$5"
IMAGE_ARCHIVE_SHA256="$6"
APP_URL="${7%/}"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/compose-secrets.env"
RUNTIME_ENVIRONMENT="$RELEASE_DIRECTORY/runtime.env"
RELEASE_METADATA="$RELEASE_DIRECTORY/release.env"
CURRENT_POINTER="$DEPLOY_ROOT/current"
PREVIOUS_DIRECTORY=""
DEPLOYMENT_COMMITTED=0

case "$RELEASE_DIRECTORY/" in
  "$DEPLOY_ROOT/releases/"*) ;;
  *) exit 65 ;;
esac

if [[ ! "$IMAGE_REFERENCE" =~ ^remote-control-hub-server:sha-[a-f0-9]{40}$ ]]; then
  exit 65
fi
if [[ ! "$COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]] || [[ ! "$BUNDLE_SHA256" =~ ^[a-f0-9]{64}$ ]] || [[ ! "$IMAGE_ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  exit 65
fi
if [[ ! "$APP_URL" =~ ^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$ ]]; then
  exit 65
fi
WEBAUTHN_RP_ID="${BASH_REMATCH[1]}"
if [[ ! -f "$RELEASE_METADATA" ]]; then
  exit 66
fi
TARGET_SCHEMA="$(sed -n 's/^TARGET_SCHEMA=//p' "$RELEASE_METADATA")"
MAXIMUM_SCHEMA="$(sed -n 's/^MAXIMUM_SCHEMA=//p' "$RELEASE_METADATA")"
if [[ ! "$TARGET_SCHEMA" =~ ^[0-9]{4}$ ]] || [[ ! "$MAXIMUM_SCHEMA" =~ ^[0-9]{4}$ ]]; then
  exit 66
fi
mkdir -p -- "$DEPLOY_ROOT/locks" "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/shared"
chmod 0700 "$DEPLOY_ROOT/shared"
exec 8> "$DEPLOY_ROOT/locks/deployment.lock"
flock --exclusive --nonblock 8

if [[ ! -f "$SHARED_ENVIRONMENT" ]]; then
  TEMPORARY_ENVIRONMENT="$(mktemp --tmpdir="$DEPLOY_ROOT/shared" .compose-secrets.XXXXXXXX)"
  chmod 0600 "$TEMPORARY_ENVIRONMENT"
  MYSQL_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  MYSQL_ROOT_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  REDIS_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'MYSQL_PASSWORD=%s\nMYSQL_ROOT_PASSWORD=%s\nREDIS_PASSWORD=%s\n' \
    "$MYSQL_PASSWORD" "$MYSQL_ROOT_PASSWORD" "$REDIS_PASSWORD" > "$TEMPORARY_ENVIRONMENT"
  mv -- "$TEMPORARY_ENVIRONMENT" "$SHARED_ENVIRONMENT"
fi
if find "$SHARED_ENVIRONMENT" -perm /077 -print -quit | grep -q .; then
  exit 66
fi
if [[ -L "$CURRENT_POINTER" ]]; then
  PREVIOUS_DIRECTORY="$(readlink -f -- "$CURRENT_POINTER")"
fi

printf 'APP_ORIGIN=%s\nRELEASE_ID=%s\nSERVER_IMAGE=%s\nWEBAUTHN_ORIGINS=["%s"]\nWEBAUTHN_RP_ID=%s\n' \
  "$APP_URL" "$COMMIT_SHA" "$IMAGE_REFERENCE" "$APP_URL" "$WEBAUTHN_RP_ID" > "$RUNTIME_ENVIRONMENT"
chmod 0600 "$RUNTIME_ENVIRONMENT"

compose() {
  docker compose \
    --project-directory "$RELEASE_DIRECTORY" \
    --file "$RELEASE_DIRECTORY/compose.yml" \
    --env-file "$SHARED_ENVIRONMENT" \
    --env-file "$RUNTIME_ENVIRONMENT" \
    "$@"
}

rollback() {
  if [[ $DEPLOYMENT_COMMITTED -eq 0 ]] && [[ -n "$PREVIOUS_DIRECTORY" ]] && [[ -d "$PREVIOUS_DIRECTORY" ]]; then
    docker compose \
      --project-directory "$PREVIOUS_DIRECTORY" \
      --file "$PREVIOUS_DIRECTORY/compose.yml" \
      --env-file "$SHARED_ENVIRONMENT" \
      --env-file "$PREVIOUS_DIRECTORY/runtime.env" \
      up --detach --remove-orphans --wait --wait-timeout 120
    ln -sfn -- "$PREVIOUS_DIRECTORY" "$DEPLOY_ROOT/current.next"
    mv -Tf -- "$DEPLOY_ROOT/current.next" "$CURRENT_POINTER"
  fi
}

trap rollback ERR

exec 9> "$DEPLOY_ROOT/locks/migration.lock"
flock --exclusive --nonblock 9

compose config --quiet
compose up --detach --wait --wait-timeout 120 \
  remote-control-hub-mysql remote-control-hub-redis

SETUP_STATUS="$(compose run --rm --no-deps remote-control-hub-server node dist/cli/index.js setup status)"
INSTALLED=0
if [[ "$SETUP_STATUS" == *'"step":"installed"'* ]]; then
  INSTALLED=1
fi

if [[ $INSTALLED -eq 1 ]]; then
  if [[ -n "$PREVIOUS_DIRECTORY" ]]; then
    PREVIOUS_MAXIMUM_SCHEMA="$(sed -n 's/^MAXIMUM_SCHEMA=//p' "$PREVIOUS_DIRECTORY/release.env")"
    if [[ ! "$PREVIOUS_MAXIMUM_SCHEMA" =~ ^[0-9]{4}$ ]] || [[ "$(printf '%s\n%s\n' "$TARGET_SCHEMA" "$PREVIOUS_MAXIMUM_SCHEMA" | sort --version-sort | tail -n 1)" != "$PREVIOUS_MAXIMUM_SCHEMA" ]]; then
      exit 67
    fi
  fi
  compose run --rm --no-deps remote-control-hub-server node dist/cli/index.js migration apply --confirm APPLY_DATABASE_MIGRATIONS
fi

MIGRATION_STATUS="$(compose run --rm --no-deps remote-control-hub-server node dist/cli/index.js migration status)"
if [[ $INSTALLED -eq 1 ]]; then
  SCHEMA_VERSION="$(sed -n 's/.*"latestExpected":"\([^"]*\)".*/\1/p' <<< "$MIGRATION_STATUS")"
else
  SCHEMA_VERSION="uninitialized"
fi
if [[ $INSTALLED -eq 1 ]] && [[ "$SCHEMA_VERSION" != "$TARGET_SCHEMA" ]]; then
  exit 67
fi

compose up --detach --remove-orphans --wait --wait-timeout 120
compose exec -T remote-control-hub-server node -e "Promise.all(['/healthz','/readyz'].map(path=>fetch('http://127.0.0.1:51692'+path).then(response=>{if(!response.ok)throw new Error(path)}))).catch(()=>process.exit(1))"
curl --fail --silent --show-error "$APP_URL/healthz" > /dev/null
curl --fail --silent --show-error "$APP_URL/readyz" > /dev/null

if [[ $INSTALLED -eq 1 ]]; then
  compose exec -T remote-control-hub-server node -e "fetch('http://127.0.0.1:51692/operationalz').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
  curl --fail --silent --show-error "$APP_URL/operationalz" > /dev/null
else
  OPERATIONAL_STATUS="$(curl --silent --output /dev/null --write-out '%{http_code}' "$APP_URL/operationalz")"
  [[ "$OPERATIONAL_STATUS" == "503" ]]
fi

WEB_RELEASE_ID="$(compose exec -T remote-control-hub-server node - "$APP_URL" < "$RELEASE_DIRECTORY/scripts/verify-web-release.mjs")"
DEPLOYED_AT="$(date --utc +'%Y-%m-%dT%H:%M:%SZ')"
printf '{"appReleaseId":"%s","bundleSha256":"%s","commit":"%s","deployedAt":"%s","image":"%s","imageArchiveSha256":"%s","schemaVersion":"%s"}\n' \
  "$WEB_RELEASE_ID" "$BUNDLE_SHA256" "$COMMIT_SHA" "$DEPLOYED_AT" "$IMAGE_REFERENCE" "$IMAGE_ARCHIVE_SHA256" "$SCHEMA_VERSION" \
  > "$RELEASE_DIRECTORY/deployment.json"

ln -sfn -- "$RELEASE_DIRECTORY" "$DEPLOY_ROOT/current.next"
mv -Tf -- "$DEPLOY_ROOT/current.next" "$CURRENT_POINTER"
DEPLOYMENT_COMMITTED=1
trap - ERR
