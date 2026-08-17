#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]] || [[ ! "$2" =~ ^[0-9]+$ ]] || ((10#$2 < 3)); then
  exit 64
fi

DEPLOY_ROOT="$(realpath -- "$1")"
RELEASES_DIRECTORY="$DEPLOY_ROOT/releases"
KEEP_COUNT="$2"
CURRENT_DIRECTORY="$(readlink -f -- "$DEPLOY_ROOT/current")"
mapfile -t RELEASES < <(find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort --numeric-sort --reverse | cut -d' ' -f2-)
RETAINED_COUNT=1

case "$CURRENT_DIRECTORY/" in
  "$RELEASES_DIRECTORY/"*) ;;
  *) exit 65 ;;
esac
if [[ ! -f "$CURRENT_DIRECTORY/runtime.env" ]]; then
  exit 66
fi

for RELEASE in "${RELEASES[@]}"; do
  TARGET="$(realpath -- "$RELEASE")"
  case "$TARGET/" in
    "$RELEASES_DIRECTORY/"*) ;;
    *) exit 65 ;;
  esac
  if [[ "$TARGET" == "$CURRENT_DIRECTORY" ]]; then
    continue
  fi
  if ((RETAINED_COUNT < KEEP_COUNT)); then
    ((RETAINED_COUNT += 1))
    continue
  fi
  rm -rf --one-file-system -- "$TARGET"
done

declare -A RETAINED_IMAGES=()
mapfile -t RETAINED_RELEASES < <(find "$RELEASES_DIRECTORY" -mindepth 1 -maxdepth 1 -type d -print)
for RETAINED_RELEASE in "${RETAINED_RELEASES[@]}"; do
  RUNTIME_ENVIRONMENT="$RETAINED_RELEASE/runtime.env"
  if [[ ! -f "$RUNTIME_ENVIRONMENT" ]]; then
    exit 66
  fi
  IMAGE_REFERENCE="$(sed -n 's/^SERVER_IMAGE=//p' "$RUNTIME_ENVIRONMENT")"
  if [[ ! "$IMAGE_REFERENCE" =~ ^remote-control-hub-server:sha-[a-f0-9]{40}$ ]]; then
    exit 66
  fi
  RETAINED_IMAGES["$IMAGE_REFERENCE"]=1
done

if ((${#RETAINED_IMAGES[@]} == 0)); then
  exit 66
fi

mapfile -t PROJECT_IMAGES < <(docker image ls --filter 'reference=remote-control-hub-server:sha-*' --format '{{.Repository}}:{{.Tag}}')
for IMAGE_REFERENCE in "${PROJECT_IMAGES[@]}"; do
  if [[ ! "$IMAGE_REFERENCE" =~ ^remote-control-hub-server:sha-[a-f0-9]{40}$ ]]; then
    continue
  fi
  if [[ -n "${RETAINED_IMAGES[$IMAGE_REFERENCE]:-}" ]]; then
    continue
  fi
  CONTAINERS="$(docker container ls --all --quiet --filter "ancestor=$IMAGE_REFERENCE")"
  if [[ -n "$CONTAINERS" ]]; then
    continue
  fi
  docker image rm "$IMAGE_REFERENCE" >/dev/null
done
