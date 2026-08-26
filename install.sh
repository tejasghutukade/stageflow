#!/usr/bin/env bash
set -euo pipefail

STAGEFLOW_PACKAGE="${STAGEFLOW_PACKAGE:-stageflow}"
STAGEFLOW_VERSION="${STAGEFLOW_VERSION:-latest}"
MIN_NODE_MAJOR=20

err() {
  echo "stageflow install: $*" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    exit 1
  fi
}

check_node() {
  need_cmd node
  local version major
  version="$(node -p "process.versions.node")"
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    err "Node.js >= ${MIN_NODE_MAJOR} required (found ${version})"
    err "Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org/ and re-run this script."
    exit 1
  fi
}

check_npm() {
  need_cmd npm
}

install_package() {
  echo "Installing ${STAGEFLOW_PACKAGE}@${STAGEFLOW_VERSION} globally via npm..."
  if [ "$STAGEFLOW_VERSION" = "latest" ]; then
    npm install -g "${STAGEFLOW_PACKAGE}@latest"
  else
    npm install -g "${STAGEFLOW_PACKAGE}@${STAGEFLOW_VERSION}"
  fi
}

verify_install() {
  need_cmd sf
  echo ""
  echo "Installed: $(sf --version 2>/dev/null || echo stageflow)"
  if node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "better-sqlite3: ok"
  else
    err "better-sqlite3 did not load. If install used --ignore-scripts, retry without it."
    err "On Linux/macOS, prebuilds cover common platforms; rebuild may need python3 and build tools."
    exit 1
  fi
}

main() {
  check_node
  check_npm
  install_package
  verify_install
  echo ""
  echo "Next: cd into a project with pipelines/, stages/, tasks/ and run:"
  echo "  sf ui"
  echo "  sf run --task tasks/<task>.yaml --pipeline <pipeline-id>"
  echo ""
  echo "Docs: https://github.com/tejasghutukade/stageflow/tree/main/docs"
}

main "$@"
