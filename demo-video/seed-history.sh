#!/usr/bin/env bash
# Seeds completed runs and agent conversations (run after seed.sh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DEMO=/Users/Shared/stageflow-demo
export STAGEFLOW_HOME="$DEMO/home" STAGEFLOW_CREDENTIAL_HOME="$DEMO/home" STAGEFLOW_SERVICE_PORT=3900
API=http://127.0.0.1:3900
cd "$DEMO/acme-ops"
sf() { node "$REPO/dist/cli.js" "$@"; }
export MOCK_FAST=1
sf run --pipeline pipelines/vendor-research.pipeline.yaml --task tasks/vendor-evaluation.task.yaml --json >/dev/null &
sf run --pipeline pipelines/incident-postmortem.pipeline.yaml --task tasks/checkout-outage.task.yaml --json >/dev/null &
chat() { curl -fsS -X POST "$API/api/agents/$1/chat" -H 'content-type: application/json' -d "$2" >/dev/null; }
chat support '{"message":"Does v2.4 have an SSO audit log?"}'
chat support '{"message":"When does the v1 export API go away?"}'
chat support '{"message":"I was charged twice for a seat after re-inviting someone. What happened?"}'
curl -sS --max-time 25 -X POST "$API/api/agents/release_ops/chat" -H 'content-type: application/json' -d '{"message":"Please update the changelog with the v2.4 notes."}' >/dev/null 2>&1 || true
wait
echo seeded
