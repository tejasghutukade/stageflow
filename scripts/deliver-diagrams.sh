#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <envelope.json> [output-dir]

Deliver Archify diagram specs listed in envelope.json to HTML.
Writes deliver-receipts.json and exits non-zero if any deliver fails.
EOF
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "deliver-diagrams: required command not found: $1" >&2
    exit 1
  fi
}

require_cmd jq
require_cmd node

ENVELOPE="${1:-}"
OUT_DIR="${2:-diagrams}"
ARCHIFY="${ARCHIFY_BIN:-.pi/skills/archify/bin/archify.mjs}"
REPO_URL="${GITHUB_REPOSITORY:+https://github.com/${GITHUB_REPOSITORY}}"
REPO_ROOT="${REPO_ROOT:-${GITHUB_WORKSPACE:-}}"

resolve_head_sha() {
  if [[ -n "${PR_HEAD_SHA:-}" ]]; then
    printf '%s\n' "$PR_HEAD_SHA"
    return
  fi
  if [[ -n "$REPO_ROOT" ]] && git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    git -C "$REPO_ROOT" rev-parse HEAD
    return
  fi
  if [[ -n "${GITHUB_SHA:-}" ]]; then
    printf '%s\n' "$GITHUB_SHA"
  fi
}

HEAD_SHA="$(resolve_head_sha)"

spec_has_sources() {
  jq -e '[.components[]? | select((.sources // []) | length > 0)] | length > 0' "$1" >/dev/null 2>&1
}

prepare_architecture_spec() {
  local spec="$1"
  local out="$2"
  if spec_has_sources "$spec"; then
    if [[ -z "$REPO_URL" || -z "$HEAD_SHA" ]]; then
      echo "deliver-diagrams: architecture spec has sources but REPO_URL or HEAD_SHA is unset" >&2
      return 1
    fi
    jq --arg url "$REPO_URL" --arg rev "$HEAD_SHA" \
      '.meta.repository = {url: $url, revision: $rev}' \
      "$spec" > "$out"
  else
    jq 'del(.meta.repository)' "$spec" > "$out"
  fi
}

[[ -n "$ENVELOPE" ]] || usage
[[ -f "$ENVELOPE" ]] || {
  echo "deliver-diagrams: envelope not found: $ENVELOPE" >&2
  exit 1
}
[[ -f "$ARCHIFY" ]] || {
  echo "deliver-diagrams: archify not found: $ARCHIFY" >&2
  exit 1
}

mkdir -p "$OUT_DIR"
receipts='[]'
failed=0

while IFS= read -r diagram; do
  TYPE="$(jq -r '.diagram_type' <<<"$diagram")"
  SPEC="$(jq -r '.spec_path' <<<"$diagram")"
  patched=""

  if [[ ! -f "$SPEC" ]]; then
    echo "deliver-diagrams: spec not found for ${TYPE}: ${SPEC}" >&2
    receipts="$(jq --arg type "$TYPE" --arg spec "$SPEC" \
      '. + [{ok:false, type:$type, input:$spec, error:"spec file not found"}]' <<<"$receipts")"
    failed=1
    continue
  fi

  deliver_spec="$SPEC"
  if [[ "$TYPE" == "architecture" ]]; then
    patched="$(mktemp)"
    if ! prepare_architecture_spec "$SPEC" "$patched"; then
      receipts="$(jq --arg type "$TYPE" --arg input "$SPEC" \
        '. + [{ok:false, type:$type, input:$input, error:"architecture sources require PR_HEAD_SHA and GITHUB_REPOSITORY"}]' <<<"$receipts")"
      failed=1
      rm -f "$patched"
      continue
    fi
    deliver_spec="$patched"
  fi

  deliver_cmd=(node "$ARCHIFY" deliver "$TYPE" "$deliver_spec" "${OUT_DIR}/${TYPE}.html" --quality showcase --json)
  if [[ "$TYPE" == "architecture" && -n "$REPO_ROOT" ]]; then
    deliver_cmd+=(--repo-root "$REPO_ROOT")
  fi

  set +e
  receipt="$("${deliver_cmd[@]}" 2>&1)"
  status=$?
  set -e

  if jq -e . >/dev/null 2>&1 <<<"$receipt"; then
    echo "$receipt" | jq '.'
    receipts="$(jq --argjson r "$(jq -c . <<<"$receipt")" '. + [$r]' <<<"$receipts")"
    if [[ "$(jq -r '.ok' <<<"$receipt")" != "true" ]]; then
      failed=1
      echo "deliver-diagrams: ${TYPE} deliver failed" >&2
    fi
  else
    echo "$receipt" >&2
    receipts="$(jq --arg type "$TYPE" --arg input "$SPEC" --arg err "$receipt" \
      '. + [{ok:false, type:$type, input:$input, error:$err}]' <<<"$receipts")"
    failed=1
  fi

  if [[ -n "$patched" ]]; then
    rm -f "$patched"
  fi

  if [[ "$status" -ne 0 && "$(jq -r '.ok // empty' <<<"${receipt:-}")" != "false" ]]; then
    failed=1
    echo "deliver-diagrams: ${TYPE} exited ${status}" >&2
  fi
done < <(jq -c '.diagrams[]' "$ENVELOPE")

jq '.' <<<"$receipts" > deliver-receipts.json
cat deliver-receipts.json

exit "$failed"
