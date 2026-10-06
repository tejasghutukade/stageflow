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

export STAGEFLOW_HOME="${STAGEFLOW_HOME:-$ROOT/.stageflow-dev}"
export STAGEFLOW_STAGE_ENV_ALLOW="${STAGEFLOW_STAGE_ENV_ALLOW:-CURSOR_API_KEY}"
unset STAGEFLOW_MIN_FREE_DISK_BYTES

if [[ -z "${CURSOR_API_KEY:-}" ]] && command -v zsh >/dev/null 2>&1; then
  from_login="$(zsh -lic 'printf %s "${CURSOR_API_KEY:-}"' 2>/dev/null || true)"
  if [[ -n "$from_login" ]]; then
    export CURSOR_API_KEY="$from_login"
  fi
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Warning: CURSOR_API_KEY is not set. Cursor models will not run until you export it or add it to your shell profile." >&2
else
  export CURSOR_API_KEY="$(printf '%s' "${CURSOR_API_KEY}" | tr -d '\n\r')"
fi

SF_CLI="$ROOT/dist/cli.js"
if [[ ! -f "$SF_CLI" ]]; then
  echo "Building Stageflow (missing $SF_CLI)…" >&2
  npm run build
  npm run ui:build
fi

echo "STAGEFLOW_HOME=$STAGEFLOW_HOME"
echo "Using CLI: node $SF_CLI ($(node "$SF_CLI" --version))"

lsof -ti :3847 2>/dev/null | xargs kill -9 2>/dev/null || true
exec node "$SF_CLI" ui --no-open "$@"
