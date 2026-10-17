#!/usr/bin/env bash
# Remotion's bundled ffmpeg/ffprobe, called directly (the npx wrapper mangles filter quoting).
D="$(cd "$(dirname "${BASH_SOURCE[0]}")/../node_modules/@remotion/compositor-darwin-arm64" && pwd)"
tool="$1"; shift
DYLD_LIBRARY_PATH="$D" "$D/$tool" "$@"
