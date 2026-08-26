#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <sf-run.json> [--stage <stage-id>] [--detect-stage <id>]

Default --stage: author-diagrams
EOF
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd jq
require_cmd sqlite3

SF_RUN_JSON=""
STAGE_ID="author-diagrams"
DETECT_STAGE_ID=""
STATE_DB=".stageflow/state.db"

if [[ $# -lt 1 ]]; then
  usage
fi

SF_RUN_JSON="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      [[ $# -ge 2 ]] || usage
      STAGE_ID="$2"
      shift 2
      ;;
    --detect-stage)
      [[ $# -ge 2 ]] || usage
      DETECT_STAGE_ID="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -f "$SF_RUN_JSON" ]] || {
  echo "error: sf-run.json not found: $SF_RUN_JSON" >&2
  exit 1
}
[[ -f "$STATE_DB" ]] || {
  echo "error: state database not found: $STATE_DB" >&2
  exit 1
}

OUTCOME="$(jq -r '.outcome // empty' "$SF_RUN_JSON")"
if [[ "$OUTCOME" != "succeeded" ]]; then
  echo "error: pipeline outcome is not succeeded (got: ${OUTCOME:-<missing>})" >&2
  exit 1
fi

RUN_ID="$(jq -r '.runId // empty' "$SF_RUN_JSON")"
RUN_DIR="$(jq -r '.runDir // empty' "$SF_RUN_JSON")"

if [[ -z "$RUN_ID" || -z "$RUN_DIR" ]]; then
  echo "error: sf-run.json missing runId or runDir" >&2
  exit 1
fi

query_envelope() {
  sqlite3 "$STATE_DB" \
    "SELECT envelope_json FROM stages WHERE run_id=? AND stage_id=?" \
    "$1" "$2"
}

if [[ -n "$DETECT_STAGE_ID" ]]; then
  DETECT_ENVELOPE="$(query_envelope "$RUN_ID" "$DETECT_STAGE_ID" || true)"
  if [[ -z "$DETECT_ENVELOPE" ]]; then
    echo "error: no envelope found for detect stage '$DETECT_STAGE_ID' in run '$RUN_ID'" >&2
    exit 1
  fi
  if jq -e '.fork_choice | type == "array" and length == 0' <<<"$DETECT_ENVELOPE" >/dev/null 2>&1; then
    jq -n '{ skipped: true }'
    exit 0
  fi
fi

AUTHOR_ENVELOPE="$(query_envelope "$RUN_ID" "$STAGE_ID" || true)"
if [[ -z "$AUTHOR_ENVELOPE" ]]; then
  echo "error: no envelope found for stage '$STAGE_ID' in run '$RUN_ID'" >&2
  exit 1
fi

DIAGRAMS="$(jq \
  --arg runDir "$RUN_DIR" \
  '
  def abs_path(rel): ($runDir | rtrimstr("/")) + "/" + (rel | ltrimstr("./"));

  . as $root |
  if ($root.payload.diagrams | type) == "array" and ($root.payload.diagrams | length) > 0 then
    [$root.payload.diagrams[] |
      . as $d |
      ([$root.artifacts[]? | select(endswith($d.diagram_type + ".spec.json"))] | first // empty) as $rel |
      if $rel == "" then
        error("no artifact matching \($d.diagram_type).spec.json in envelope for stage")
      else
        {
          diagram_type: $d.diagram_type,
          summary: ($d.summary // ""),
          spec_path: abs_path($rel)
        }
      end
    ]
  else
    [$root.artifacts[]? | select(test("\\.spec\\.json$")) |
      . as $rel |
      ($rel | capture("(?<type>[^/]+)\\.spec\\.json$").type) as $type |
      {
        diagram_type: $type,
        summary: ($root.summary // ""),
        spec_path: abs_path($rel)
      }
    ]
  end
  ' <<<"$AUTHOR_ENVELOPE")"

if [[ "$(jq 'length' <<<"$DIAGRAMS")" -eq 0 ]]; then
  echo "error: no *.spec.json artifacts or payload.diagrams in envelope for stage '$STAGE_ID'" >&2
  exit 1
fi

jq -n \
  --arg runId "$RUN_ID" \
  --arg runDir "$RUN_DIR" \
  --arg stageId "$STAGE_ID" \
  --argjson diagrams "$DIAGRAMS" \
  '{
    skipped: false,
    runId: $runId,
    runDir: $runDir,
    stageId: $stageId,
    diagrams: $diagrams
  }'
