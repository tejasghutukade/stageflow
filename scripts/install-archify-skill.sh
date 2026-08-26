#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
DEST="${ROOT}/.pi/skills/archify"
VERSION=""
SOURCE_DIR=""
ZIP_URL=""
TMP_EXTRACT_DIR=""

usage() {
  cat <<'EOF'
Usage: install-archify-skill.sh [--source-dir PATH | --zip-url URL] [--version VERSION]

Install Archify skill to .pi/skills/archify/ in the current working directory.

Options:
  --source-dir PATH   Local path to Archify skill tree
  --zip-url URL       URL to Archify release zip
  --version VERSION   Version label for logging (optional)

Environment:
  ARCHIFY_SOURCE_DIR  Local path (used if --source-dir not set)
  ARCHIFY_ZIP_URL     Zip URL (used if --zip-url not set)

When neither is set, downloads Archify v2.15.0 from the public GitHub release.
EOF
}

err() {
  echo "install-archify-skill: $*" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    exit 1
  fi
}

cleanup() {
  if [ -n "$TMP_EXTRACT_DIR" ] && [ -d "$TMP_EXTRACT_DIR" ]; then
    rm -rf "$TMP_EXTRACT_DIR"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source-dir)
        SOURCE_DIR="${2:?--source-dir requires a path}"
        shift 2
        ;;
      --zip-url)
        ZIP_URL="${2:?--zip-url requires a URL}"
        shift 2
        ;;
      --version)
        VERSION="${2:?--version requires a value}"
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

  if [ -z "$SOURCE_DIR" ] && [ -n "${ARCHIFY_SOURCE_DIR:-}" ]; then
    SOURCE_DIR="$ARCHIFY_SOURCE_DIR"
  fi
  if [ -z "$ZIP_URL" ] && [ -n "${ARCHIFY_ZIP_URL:-}" ]; then
    ZIP_URL="$ARCHIFY_ZIP_URL"
  fi
  if [ -z "$SOURCE_DIR" ] && [ -z "$ZIP_URL" ]; then
    ZIP_URL="https://github.com/tt-a1i/archify/releases/download/v2.15.0/archify.zip"
  fi
}

find_skill_root() {
  local extract_root="$1"

  if [ -f "${extract_root}/bin/archify.mjs" ]; then
    printf '%s\n' "$extract_root"
    return
  fi
  if [ -f "${extract_root}/archify/bin/archify.mjs" ]; then
    printf '%s\n' "${extract_root}/archify"
    return
  fi

  local found
  found="$(find "$extract_root" -path '*/bin/archify.mjs' -print -quit 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s\n' "$(dirname "$(dirname "$found")")"
    return
  fi

  err "could not locate Archify skill root in extracted archive"
  exit 1
}

RESOLVED_SRC=""

resolve_source_from_zip() {
  need_cmd curl
  need_cmd unzip

  TMP_EXTRACT_DIR="$(mktemp -d)"
  trap cleanup EXIT

  local zipfile="${TMP_EXTRACT_DIR}/archify.zip"
  echo "Downloading Archify from ${ZIP_URL}" >&2
  curl -fsSL "$ZIP_URL" -o "$zipfile"
  unzip -q "$zipfile" -d "${TMP_EXTRACT_DIR}/extract"
  RESOLVED_SRC="$(find_skill_root "${TMP_EXTRACT_DIR}/extract")"
}

resolve_source_dir() {
  if [ -n "$SOURCE_DIR" ] && [ -n "$ZIP_URL" ]; then
    err "specify only one of --source-dir or --zip-url"
    exit 1
  fi

  if [ -n "$SOURCE_DIR" ]; then
    if [ ! -d "$SOURCE_DIR" ]; then
      err "source directory not found: $SOURCE_DIR"
      exit 1
    fi
    if [ ! -f "$SOURCE_DIR/bin/archify.mjs" ]; then
      err "source directory missing bin/archify.mjs: $SOURCE_DIR"
      exit 1
    fi
    RESOLVED_SRC="$SOURCE_DIR"
    return
  fi

  if [ -n "$ZIP_URL" ]; then
    resolve_source_from_zip
    return
  fi

  err "no source specified; use --source-dir, --zip-url, ARCHIFY_SOURCE_DIR, or ARCHIFY_ZIP_URL"
  exit 1
}

copy_skill() {
  local src="$1"

  rm -rf "$DEST"
  mkdir -p "$DEST"

  tar -C "$src" \
    --exclude='test' \
    --exclude='node_modules' \
    --exclude='package-lock.json' \
    --exclude='scripts/generate-*' \
    -cf - . | tar -C "$DEST" -xf -
}

verify_install() {
  if [ ! -f "$DEST/bin/archify.mjs" ]; then
    err "install failed: $DEST/bin/archify.mjs not found"
    exit 1
  fi

  need_cmd node
  if ! node "$DEST/bin/archify.mjs" doctor; then
    err "archify doctor failed"
    exit 1
  fi
}

main() {
  parse_args "$@"

  resolve_source_dir

  if [ -n "$VERSION" ]; then
    echo "Installing Archify ${VERSION} to ${DEST}"
  else
    echo "Installing Archify to ${DEST}"
  fi
  echo "Source: ${RESOLVED_SRC}"

  copy_skill "$RESOLVED_SRC"
  verify_install
  cleanup
  trap - EXIT

  echo "Archify skill installed at ${DEST}"
}

main "$@"
