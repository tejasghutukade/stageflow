#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
sf validate --strict --json
