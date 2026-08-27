#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [output.json]

Resolve PR/git context for Archify-on-PR before Stageflow runs.
Writes ci-context.json with head_sha, repo metadata, changed files, and
path verification at the pinned head commit.

Environment:
  PR_HEAD_SHA        PR head commit (preferred over git rev-parse HEAD)
  GITHUB_REPOSITORY  owner/repo
  GITHUB_BASE_REF    base branch (default: main)
  GITHUB_HEAD_REF    head branch name
  GITHUB_EVENT_PATH  GitHub Actions event payload (for pr_number)
  REPO_ROOT          git checkout root (default: GITHUB_WORKSPACE or pwd)
EOF
  exit 1
}

err() {
  echo "prepare-ci-context: $*" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 1
  fi
}

need_cmd jq
need_cmd git

hash_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

OUTPUT="${1:-ci-context.json}"
REPO_ROOT="${REPO_ROOT:-${GITHUB_WORKSPACE:-$(pwd)}}"

if [[ ! -d "${REPO_ROOT}/.git" ]]; then
  err "not a git repository: ${REPO_ROOT}"
  exit 1
fi

resolve_head_sha() {
  if [[ -n "${PR_HEAD_SHA:-}" ]]; then
    printf '%s' "$PR_HEAD_SHA"
    return
  fi
  git -C "$REPO_ROOT" rev-parse HEAD
}

resolve_base_ref() {
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    printf '%s' "$GITHUB_BASE_REF"
    return
  fi
  printf '%s' "main"
}

resolve_head_ref() {
  if [[ -n "${GITHUB_HEAD_REF:-}" ]]; then
    printf '%s' "$GITHUB_HEAD_REF"
    return
  fi
  git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

resolve_repository() {
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    printf '%s' "$GITHUB_REPOSITORY"
    return
  fi
  local origin
  origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ "$origin" =~ github\.com[:/]([^/]+/[^/.]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]%.git}"
  fi
}

resolve_pr_number() {
  if [[ -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
    jq -r '.pull_request.number // .number // empty' "${GITHUB_EVENT_PATH}" 2>/dev/null || true
    return
  fi
  if command -v gh >/dev/null 2>&1; then
    gh pr view --json number -q .number 2>/dev/null || true
  fi
}

resolve_diff_base() {
  local base_ref="$1"
  if git -C "$REPO_ROOT" rev-parse "origin/${base_ref}" >/dev/null 2>&1; then
    printf 'origin/%s' "$base_ref"
    return
  fi
  if git -C "$REPO_ROOT" rev-parse "${base_ref}" >/dev/null 2>&1; then
    printf '%s' "$base_ref"
    return
  fi
  printf '%s' ""
}

collect_changed_files() {
  local diff_base="$1"
  local head_sha="$2"
  if [[ -n "$diff_base" ]]; then
    git -C "$REPO_ROOT" diff --name-only "${diff_base}...${head_sha}" 2>/dev/null || true
    return
  fi
  if git -C "$REPO_ROOT" rev-parse HEAD~1 >/dev/null 2>&1; then
    git -C "$REPO_ROOT" diff --name-only HEAD~1 HEAD 2>/dev/null || true
    return
  fi
  git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null || true
}

path_exists_at_revision() {
  local head_sha="$1"
  local path="$2"
  git -C "$REPO_ROOT" cat-file -e "${head_sha}:${path}" >/dev/null 2>&1
}

HEAD_SHA="$(resolve_head_sha)"
BASE_REF="$(resolve_base_ref)"
HEAD_REF="$(resolve_head_ref)"
REPOSITORY="$(resolve_repository)"
PR_NUMBER="$(resolve_pr_number)"
DIFF_BASE="$(resolve_diff_base "$BASE_REF")"

if ! git -C "$REPO_ROOT" cat-file -e "${HEAD_SHA}^{commit}" >/dev/null 2>&1; then
  err "head commit not available in checkout: ${HEAD_SHA}"
  exit 1
fi

mapfile -t CHANGED_FILES 2>/dev/null < <(collect_changed_files "$DIFF_BASE" "$HEAD_SHA" | sed '/^$/d' | sort -u) || {
  CHANGED_FILES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && CHANGED_FILES+=("$line")
  done < <(collect_changed_files "$DIFF_BASE" "$HEAD_SHA" | sed '/^$/d' | sort -u)
}

VERIFIED_PATHS='{}'
for path in "${CHANGED_FILES[@]}"; do
  if path_exists_at_revision "$HEAD_SHA" "$path"; then
    VERIFIED_PATHS="$(jq --arg p "$path" '. + {($p): true}' <<<"$VERIFIED_PATHS")"
  else
    VERIFIED_PATHS="$(jq --arg p "$path" '. + {($p): false}' <<<"$VERIFIED_PATHS")"
  fi
done

if ((${#CHANGED_FILES[@]} > 0)); then
  CONTENT_HASH="$(printf '%s\n' "${CHANGED_FILES[@]}" | hash_files)"
else
  CONTENT_HASH="$(printf '' | hash_files)"
fi

REPO_URL=""
if [[ -n "$REPOSITORY" ]]; then
  REPO_URL="https://github.com/${REPOSITORY}"
fi

jq -n \
  --arg schema_version "1" \
  --arg pr_number "${PR_NUMBER}" \
  --arg base_ref "$BASE_REF" \
  --arg head_ref "$HEAD_REF" \
  --arg head_sha "$HEAD_SHA" \
  --arg repository "$REPOSITORY" \
  --arg repo_url "$REPO_URL" \
  --arg diff_base "$DIFF_BASE" \
  --arg content_hash "$CONTENT_HASH" \
  --argjson changed_files "$(printf '%s\n' "${CHANGED_FILES[@]}" | jq -R -s 'split("\n") | map(select(length > 0))')" \
  --argjson verified_paths "$VERIFIED_PATHS" \
  '{
    schema_version: $schema_version,
    pr_number: $pr_number,
    base_ref: $base_ref,
    head_ref: $head_ref,
    head_sha: $head_sha,
    repository: $repository,
    repo_url: $repo_url,
    diff_base: $diff_base,
    changed_files: $changed_files,
    verified_paths: $verified_paths,
    content_hash: $content_hash
  }' >"$OUTPUT"

cat "$OUTPUT"
