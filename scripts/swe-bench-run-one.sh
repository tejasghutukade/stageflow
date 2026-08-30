#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if [[ ! -f dist/cli.js ]]; then
  echo "error: run npm run build at repo root first" >&2
  exit 1
fi

INSTANCE_ID="${1:-}"
if [[ -z "${INSTANCE_ID}" ]]; then
  echo "usage: $0 <instance_id> [output_dir]" >&2
  exit 1
fi

OUTPUT_DIR="${2:-${ROOT}/benchmarks/swe-bench/runs/smoke-one}"
PIPELINE="${ROOT}/benchmarks/swe-bench/pipelines/swe-agentless-lite.pipeline.yaml"

pip install -q -e "${ROOT}/benchmarks/swe-bench" 2>/dev/null || pip install -e "${ROOT}/benchmarks/swe-bench"

python3 -m harness batch \
  --subset lite \
  --split dev \
  --workers 1 \
  --output-dir "${OUTPUT_DIR}" \
  --pipeline "${PIPELINE}" \
  --instance-ids "${INSTANCE_ID}"
