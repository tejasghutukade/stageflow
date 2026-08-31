#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR"
DEST_ROOT="$(pwd)"

SKILLS=(
  stageflow
  stageflow-setup
  stageflow-session-capture
  stageflow-author
  stageflow-run
  stageflow-delegate
)

TARGETS=(
  .cursor/skills
  .claude/skills
  .agents/skills
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

copy_suite() {
  local target skill
  for target in "${TARGETS[@]}"; do
    mkdir -p "${DEST_ROOT}/${target}"
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
