#!/usr/bin/env bash
# Wait until stageflow@version is queryable on the npm registry, then install it
# globally. `npm publish` can finish before the version is visible on every edge
# (observed ~6 minutes for 0.27.0); a short install-retry loop can also cache
# ETARGET 404s and keep failing after the package appears.
set -euo pipefail

VERSION="${1:?usage: wait-install-npm-stageflow.sh <x.y.z> [max_attempts]}"
MAX_ATTEMPTS="${2:-90}"
SLEEP_SECS="${NPM_WAIT_SLEEP_SECS:-10}"

if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version '${VERSION}'; expected x.y.z" >&2
  exit 1
fi

META_URL="https://registry.npmjs.org/stageflow/${VERSION}"
echo "Waiting for ${META_URL} (up to ${MAX_ATTEMPTS} attempts, ${SLEEP_SECS}s apart)"

ok=0
for i in $(seq 1 "${MAX_ATTEMPTS}"); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${META_URL}" || true)"
  if [ "${code}" = "200" ]; then
    ok=1
    echo "registry reports stageflow@${VERSION} (attempt ${i}/${MAX_ATTEMPTS})"
    break
  fi
  echo "waiting for npm registry (${i}/${MAX_ATTEMPTS}) http=${code}"
  sleep "${SLEEP_SECS}"
done

if [ "${ok}" != 1 ]; then
  echo "timed out waiting for stageflow@${VERSION} on npm" >&2
  exit 1
fi

# Fresh cache so a prior ETARGET 404 cannot poison the install.
CACHE_DIR="$(mktemp -d)"
trap 'rm -rf "${CACHE_DIR}"' EXIT
npm i -g "stageflow@${VERSION}" --prefer-online --cache "${CACHE_DIR}"

INSTALLED="$(node -p "require(require('child_process').execSync('npm root -g',{encoding:'utf8'}).trim() + '/stageflow/package.json').version")"
echo "installed stageflow@${INSTALLED}"
if [ "${INSTALLED}" != "${VERSION}" ]; then
  echo "expected stageflow@${VERSION}" >&2
  exit 1
fi
command -v sf
command -v stageflow
