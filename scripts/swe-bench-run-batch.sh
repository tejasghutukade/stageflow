#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if [[ ! -f dist/cli.js ]]; then
  echo "error: run npm run build at repo root first" >&2
  exit 1
fi

OUTPUT_DIR="${1:-${ROOT}/benchmarks/swe-bench/runs/batch}"
SUBSET="${2:-lite}"
SPLIT="${3:-dev}"
WORKERS="${4:-1}"
SLICE="${5:-0:2}"
PIPELINE="${ROOT}/benchmarks/swe-bench/pipelines/stub.pipeline.yaml"

pip install -q -e "${ROOT}/benchmarks/swe-bench" 2>/dev/null || pip install -e "${ROOT}/benchmarks/swe-bench"

python3 -m harness batch \
  --subset "${SUBSET}" \
  --split "${SPLIT}" \
  --workers "${WORKERS}" \
  --slice "${SLICE}" \
  --output-dir "${OUTPUT_DIR}" \
  --pipeline "${PIPELINE}" \
  --resume
