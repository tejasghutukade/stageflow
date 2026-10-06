#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY is not set. Export it or add it to $ROOT/.env (gitignored)." >&2
  exit 1
fi
export CURSOR_API_KEY="$(printf '%s' "${CURSOR_API_KEY}" | tr -d '\n\r')"

if lsof -i :3847 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3847 is in use. Stop sf ui / sf mcp first so this script can autostart the Host with release env (same as GitHub Actions)." >&2
  echo "Or restart the Host with: STAGEFLOW_STAGE_ENV_ALLOW=CURSOR_API_KEY CURSOR_API_KEY=… sf ui --no-open" >&2
  exit 1
fi

CURRENT="${RELEASE_VERSION:-$(node -p "require('./package.json').version")}"
TAG="${RELEASE_TAG:-v${CURRENT}}"
PREVIOUS="${RELEASE_PREVIOUS:-$(node scripts/release-range.mjs previous --current "${CURRENT}" 2>/dev/null || true)}"
SLICE="${RELEASE_CHANGELOG_SLICE:-$ROOT/changelog-slice.md}"

if [[ -n "${PREVIOUS}" ]]; then
  node scripts/release-range.mjs changelog --after "${PREVIOUS}" --through "${CURRENT}" --file CHANGELOG.md >"${SLICE}"
else
  node scripts/release-range.mjs changelog --through "${CURRENT}" --file CHANGELOG.md >"${SLICE}"
fi

export RELEASE_VERSION="$CURRENT"
export RELEASE_TAG="$TAG"
export RELEASE_PREVIOUS="$PREVIOUS"
export RELEASE_CHANGELOG_SLICE="$SLICE"
export STAGEFLOW_STAGE_ENV_ALLOW=CURSOR_API_KEY
export STAGEFLOW_HOME="${STAGEFLOW_HOME:-$ROOT/.stageflow-github-release-local}"
export STAGEFLOW_MIN_FREE_DISK_BYTES="${STAGEFLOW_MIN_FREE_DISK_BYTES:-0}"
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

echo "Using sf: $(command -v sf) ($(sf --version))"
echo "STAGEFLOW_HOME=$STAGEFLOW_HOME"
echo "Release ${TAG} (previous GitHub release: ${PREVIOUS:-none})"

sf validate --strict --json >/dev/null

set +e
sf run \
  --pipeline examples/github-release/github-release.pipeline.yaml \
  --task examples/github-release/github-release.task.yaml \
  --checkout "$ROOT" \
  --json --skip-gates \
  "${@}"
status=$?
set -e
exit "$status"
