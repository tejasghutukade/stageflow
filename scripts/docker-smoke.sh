#!/usr/bin/env bash
# Build the Stageflow image and prove the container becomes live (/livez).
# Mandatory bar: GET /livez → 200. Does not use sf doctor as the health probe.
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Build the Stageflow Docker image (host arch), run it with a temp volume and
control token, poll GET /livez until 200, then tear down.

Options:
  --timeout SECS     Max seconds to wait for /livez (default: 120)
  --image NAME       Image tag to build/run (default: stageflow:smoke)
  --host-port PORT   Host port to publish (default: ephemeral / random)
  --readyz           Stretch: also require GET /readyz → 200 after livez
  --check-build-sha  Stretch: GET /api/health with token; assert build_sha
                     matches STAGEFLOW_BUILD_SHA baked into the image
  -h, --help         Show this help

Environment:
  STAGEFLOW_BUILD_SHA  Override git SHA baked into the image
  SMOKE_TIMEOUT        Same as --timeout
  SMOKE_IMAGE          Same as --image
  SMOKE_HOST_PORT      Same as --host-port (0 = ephemeral)

Exit 0 on success; non-zero on failure with a clear message on stderr.
EOF
}

err() {
  echo "docker-smoke: $*" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 1
  fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SMOKE_IMAGE:-stageflow:smoke}"
TIMEOUT_SECS="${SMOKE_TIMEOUT:-120}"
HOST_PORT="${SMOKE_HOST_PORT:-0}"
CHECK_READYZ=0
CHECK_BUILD_SHA=0
CONTAINER_ID=""
VOLUME_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      TIMEOUT_SECS="${2:?--timeout requires a value}"
      shift 2
      ;;
    --image)
      IMAGE="${2:?--image requires a value}"
      shift 2
      ;;
    --host-port)
      HOST_PORT="${2:?--host-port requires a value}"
      shift 2
      ;;
    --readyz)
      CHECK_READYZ=1
      shift
      ;;
    --check-build-sha)
      CHECK_BUILD_SHA=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd docker
need_cmd curl
need_cmd git

if ! docker info >/dev/null 2>&1; then
  err "Docker daemon is not reachable (is Docker Desktop / the daemon running?)"
  exit 1
fi

if [[ ! -f "${REPO_ROOT}/Dockerfile" ]]; then
  err "Dockerfile not found at ${REPO_ROOT}/Dockerfile"
  exit 1
fi

BUILD_SHA="${STAGEFLOW_BUILD_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
if [[ -z "$BUILD_SHA" || "$BUILD_SHA" == "unknown" ]]; then
  err "STAGEFLOW_BUILD_SHA resolved empty/unknown; pass STAGEFLOW_BUILD_SHA or run inside a git checkout"
  exit 1
fi

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  else
    err "need openssl or python3 to generate a control token"
    exit 1
  fi
}

CONTROL_TOKEN="$(generate_token)"
if [[ ${#CONTROL_TOKEN} -lt 32 ]]; then
  err "generated control token is shorter than 32 characters"
  exit 1
fi

VOLUME_NAME="stageflow-smoke-$(date +%s)-$$"
CONTAINER_NAME="stageflow-smoke-$$"

cleanup() {
  local ec=$?
  if [[ -n "$CONTAINER_ID" ]]; then
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  elif docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$VOLUME_NAME" ]]; then
    docker volume rm -f "$VOLUME_NAME" >/dev/null 2>&1 || true
  fi
  exit "$ec"
}
trap cleanup EXIT

err "building image ${IMAGE} (STAGEFLOW_BUILD_SHA=${BUILD_SHA})"
docker build \
  --build-arg "STAGEFLOW_BUILD_SHA=${BUILD_SHA}" \
  -t "$IMAGE" \
  "$REPO_ROOT"

err "creating volume ${VOLUME_NAME}"
docker volume create "$VOLUME_NAME" >/dev/null

err "starting container (STAGEFLOW_HOME=/data, TMPDIR=/data/tmp, port ${HOST_PORT}:3847)"
CONTAINER_ID="$(
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e STAGEFLOW_HOME=/data \
    -e TMPDIR=/data/tmp \
    -e SQLITE_TMPDIR=/data/tmp \
    -e "STAGEFLOW_CONTROL_TOKEN=${CONTROL_TOKEN}" \
    -v "${VOLUME_NAME}:/data" \
    -p "${HOST_PORT}:3847" \
    "$IMAGE"
)"

MAPPED_PORT="$(
  docker port "$CONTAINER_ID" 3847/tcp \
    | head -n 1 \
    | sed -E 's/.*:([0-9]+)$/\1/'
)"
if [[ -z "$MAPPED_PORT" || ! "$MAPPED_PORT" =~ ^[0-9]+$ ]]; then
  err "failed to resolve published host port for 3847/tcp"
  docker logs "$CONTAINER_ID" >&2 || true
  exit 1
fi

LIVEZ_URL="http://127.0.0.1:${MAPPED_PORT}/livez"
err "polling ${LIVEZ_URL} (timeout ${TIMEOUT_SECS}s)"

deadline=$((SECONDS + TIMEOUT_SECS))
livez_ok=0
last_curl_ec=1
last_http=""
while (( SECONDS < deadline )); do
  set +e
  last_http="$(curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$LIVEZ_URL" 2>/dev/null)"
  last_curl_ec=$?
  set -e
  if [[ $last_curl_ec -eq 0 && "$last_http" == "200" ]]; then
    livez_ok=1
    break
  fi
  sleep 2
done

if [[ $livez_ok -ne 1 ]]; then
  err "timed out waiting for /livez → 200 at ${LIVEZ_URL} (last http=${last_http:-none} curl_ec=${last_curl_ec})"
  err "container logs:"
  docker logs "$CONTAINER_ID" >&2 || true
  exit 1
fi

err "/livez returned 200"

if [[ $CHECK_READYZ -eq 1 ]]; then
  READYZ_URL="http://127.0.0.1:${MAPPED_PORT}/readyz"
  err "stretch: polling ${READYZ_URL}"
  ready_deadline=$((SECONDS + 60))
  ready_ok=0
  while (( SECONDS < ready_deadline )); do
    set +e
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$READYZ_URL" 2>/dev/null)"
    ec=$?
    set -e
    if [[ $ec -eq 0 && "$code" == "200" ]]; then
      ready_ok=1
      break
    fi
    sleep 2
  done
  if [[ $ready_ok -ne 1 ]]; then
    err "stretch --readyz failed: /readyz did not return 200"
    docker logs "$CONTAINER_ID" >&2 || true
    exit 1
  fi
  err "/readyz returned 200"
fi

if [[ $CHECK_BUILD_SHA -eq 1 ]]; then
  HEALTH_URL="http://127.0.0.1:${MAPPED_PORT}/api/health"
  err "stretch: checking build_sha via ${HEALTH_URL}"
  set +e
  health_body="$(curl -fsS --connect-timeout 2 --max-time 10 \
    -H "Authorization: Bearer ${CONTROL_TOKEN}" \
    "$HEALTH_URL" 2>/dev/null)"
  health_ec=$?
  set -e
  if [[ $health_ec -ne 0 || -z "$health_body" ]]; then
    err "stretch --check-build-sha failed: could not GET /api/health with control token"
    docker logs "$CONTAINER_ID" >&2 || true
    exit 1
  fi
  reported_sha=""
  if command -v python3 >/dev/null 2>&1; then
    reported_sha="$(printf '%s' "$health_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("build_sha",""))')"
  elif command -v jq >/dev/null 2>&1; then
    reported_sha="$(printf '%s' "$health_body" | jq -r '.build_sha // empty')"
  else
    err "stretch --check-build-sha requires python3 or jq to parse /api/health"
    exit 1
  fi
  if [[ "$reported_sha" != "$BUILD_SHA" ]]; then
    err "stretch --check-build-sha failed: build_sha='${reported_sha}' expected='${BUILD_SHA}'"
    exit 1
  fi
  err "build_sha matches ${BUILD_SHA}"
fi

err "OK — image boots and /livez is live"
exit 0
