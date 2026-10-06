#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run build && npm run ui:build
npm link
INSTALLED="$(node -p "require(require('child_process').execSync('npm root -g',{encoding:'utf8'}).trim() + '/stageflow/package.json').version")"
echo "linked stageflow@${INSTALLED} from checkout"
command -v sf
sf --version
