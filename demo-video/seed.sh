#!/usr/bin/env bash
# Rebuilds the isolated demo environment: mock LLM + Stageflow console + seeded history.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DEMO=/Users/Shared/stageflow-demo
PORT=3900
pkill -f "cli.js ui --port $PORT" 2>/dev/null || true
pkill -f "mock-llm/server.mjs" 2>/dev/null || true
sleep 1
rm -rf "$DEMO"; mkdir -p "$DEMO/home/agent"
cp -R "$HERE/acme-ops" "$DEMO/acme-ops"
( cd "$DEMO/acme-ops" && git init -q && git add -A && git -c user.email=demo@acme.example -c user.name=Acme commit -qm "Acme ops workflows" )
cat > "$DEMO/home/agent/models.json" <<'JSON'
{"providers":{"demo":{"baseUrl":"http://127.0.0.1:4010/v1","api":"openai-completions","apiKey":"demo","models":[{"id":"demo-1","name":"Demo model","contextWindow":200000,"maxTokens":8192,"cost":{"input":3,"output":15,"cacheRead":0,"cacheWrite":0}}]}}}
JSON
echo '{"demo":{"type":"api_key","key":"demo-local-key"}}' > "$DEMO/home/agent/auth.json"; chmod 600 "$DEMO/home/agent/auth.json"
export STAGEFLOW_HOME="$DEMO/home" STAGEFLOW_CREDENTIAL_HOME="$DEMO/home" STAGEFLOW_SERVICE_PORT=$PORT
( cd "$HERE" && MOCK_LLM_LOG="$DEMO/mock.log" nohup node mock-llm/server.mjs > "$DEMO/mock.out" 2>&1 & )
( cd "$DEMO/acme-ops" && nohup node "$REPO/dist/cli.js" ui --port $PORT > "$DEMO/ui.log" 2>&1 & )
for i in $(seq 1 30); do curl -fs "localhost:$PORT/livez" >/dev/null 2>&1 && break; sleep 1; done
echo "console: http://127.0.0.1:$PORT"
