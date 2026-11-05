#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR"
DEST_ROOT="$(pwd)"

SKILLS=(
  stageflow
  stageflow-pipelines
  stageflow-agents
  stageflow-operate
  stageflow-evals
)

TARGETS=(
  .cursor/skills
  .claude/skills
  .agents/skills
)

LEGACY_SKILLS=(
  stageflow-setup
  stageflow-author
  stageflow-session-capture
  stageflow-delegate
  stageflow-run
)

usage() {
  cat <<'EOF'
Usage: install-suite.sh [--source-dir PATH] [--dest-cwd PATH]

Copy the Stageflow harness skills suite into a project's
.cursor/skills/, .claude/skills/, and .agents/skills/.

Options:
  --source-dir PATH   Canonical skills tree (default: this script's directory)
  --dest-cwd PATH     Project root to install into (default: current directory)
EOF
}

err() {
  echo "install-suite: $*" >&2
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source-dir)
        SOURCE_DIR="${2:?--source-dir requires a path}"
        shift 2
        ;;
      --dest-cwd)
        DEST_ROOT="${2:?--dest-cwd requires a path}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "unknown argument: $1"
        usage >&2
        exit 1
        ;;
    esac
  done
}

resolve_paths() {
  if [ ! -d "$SOURCE_DIR" ]; then
    err "source directory not found: $SOURCE_DIR"
    exit 1
  fi
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

  if [ ! -d "$DEST_ROOT" ]; then
    err "destination directory not found: $DEST_ROOT"
    exit 1
  fi
  DEST_ROOT="$(cd "$DEST_ROOT" && pwd)"

  local expected="${SOURCE_DIR}/stageflow/SKILL.md"
  if [ ! -f "$expected" ]; then
    err "source directory missing stageflow/SKILL.md: ${expected}"
    exit 1
  fi
}

frontmatter_name() {
  local file="$1"
  local line=""
  line="$(awk 'NR==1 && $0=="---"{fm=1; next} fm && $0=="---"{exit} fm && /^name:/{print; exit}' "$file" || true)"
  line="${line#name:}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  line="${line#\"}"
  line="${line%\"}"
  line="${line#\'}"
  line="${line%\'}"
  printf '%s' "$line"
}

remove_legacy_skills() {
  local target="$1"
  local skill dir name
  for skill in "${LEGACY_SKILLS[@]}"; do
    dir="${DEST_ROOT}/${target}/${skill}"
    if [ -f "${dir}/SKILL.md" ]; then
      name="$(frontmatter_name "${dir}/SKILL.md")"
      if [ "$name" = "$skill" ]; then
        rm -rf "$dir"
      fi
    fi
  done
}

copy_suite() {
  local target skill
  for target in "${TARGETS[@]}"; do
    mkdir -p "${DEST_ROOT}/${target}"
    remove_legacy_skills "$target"
    for skill in "${SKILLS[@]}"; do
      rm -rf "${DEST_ROOT}/${target}/${skill}"
      cp -R "${SOURCE_DIR}/${skill}" "${DEST_ROOT}/${target}/${skill}"
    done
  done
}

main() {
  parse_args "$@"
  resolve_paths
  copy_suite

  echo "Installed Stageflow skills suite"
  echo "Source: ${SOURCE_DIR}"
  for target in "${TARGETS[@]}"; do
    echo "${DEST_ROOT}/${target}"
  done
}

main "$@"
