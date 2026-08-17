#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]] || [[ "$2" != "VERIFY_REDIS_AOF" ]]; then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
SHARED_ENVIRONMENT="$DEPLOY_ROOT/shared/compose-secrets.env"
RUNTIME_ENVIRONMENT="$CURRENT_DIRECTORY/runtime.env"
SENTINEL_KEY="rch:aof-check:$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
SENTINEL_VALUE="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"

compose() {
  docker compose \
    --project-directory "$CURRENT_DIRECTORY" \
    --file "$CURRENT_DIRECTORY/compose.yml" \
    --env-file "$SHARED_ENVIRONMENT" \
    --env-file "$RUNTIME_ENVIRONMENT" \
    "$@"
}

redis() {
  compose exec -T remote-control-hub-redis sh -eu -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"' sh "$@"
}

[[ "$(redis CONFIG GET appendonly | tail -n 1)" == "yes" ]]
redis SET "$SENTINEL_KEY" "$SENTINEL_VALUE" EX 300 >/dev/null
redis BGREWRITEAOF >/dev/null
for _ in {1..60}; do
  if [[ "$(redis INFO persistence | tr -d '\r' | sed -n 's/^aof_rewrite_in_progress://p')" == "0" ]]; then
    break
  fi
  sleep 1
done
[[ "$(redis INFO persistence | tr -d '\r' | sed -n 's/^aof_last_bgrewrite_status://p')" == "ok" ]]
compose restart remote-control-hub-redis >/dev/null
for _ in {1..30}; do
  if [[ "$(redis PING 2>/dev/null || true)" == "PONG" ]]; then
    break
  fi
  sleep 2
done
[[ "$(redis GET "$SENTINEL_KEY")" == "$SENTINEL_VALUE" ]]
TTL="$(redis TTL "$SENTINEL_KEY")"
[[ "$TTL" =~ ^[1-9][0-9]*$ ]]
redis DEL "$SENTINEL_KEY" >/dev/null
printf '%s\n' "$TTL"
