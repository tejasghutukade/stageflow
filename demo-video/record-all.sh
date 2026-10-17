#!/usr/bin/env bash
# Fresh demo state, then record every scene in an order that keeps state consistent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
./seed.sh >/dev/null
./seed-history.sh >/dev/null 2>&1
for s in inspect editor agents webchat connect liverun approval; do
  echo "== $s"; node capture/scene-$s.mjs
done
cp out/clips/*.webm public/clips/
node scripts/probe.mjs
