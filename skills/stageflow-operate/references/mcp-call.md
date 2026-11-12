# mcp-call

Use [`../scripts/mcp-call.mjs`](../scripts/mcp-call.mjs) when the Stageflow host is up and this harness has no native Stageflow MCP tools. Do not start `sf mcp` from this skill.

```
node scripts/mcp-call.mjs --base-url <url> --tool <name> --args '<json>' [--stateless]
```

Default `--base-url` is `http://127.0.0.1:3847`. `--args` defaults to `{}`.

## Auth

The script sends `Authorization: Bearer <token>` on every `/mcp` request when it can load a drive token from `STAGEFLOW_CONTROL_TOKEN`, `STAGEFLOW_CONTROL_TOKEN_FILE`, or — when both are unset — `$STAGEFLOW_HOME/control-token` (same path the CLI reads). Export it for other tools:

```bash
export STAGEFLOW_CONTROL_TOKEN="$(tr -d '\n' < "${STAGEFLOW_HOME:-$HOME/.stageflow}/control-token")"
```

A Host start with no operator token writes that file and prints `Control token: <token>` once. Omit the bearer only when the Host started with `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1`; the shipped Compose file does not set it. `--probe` calls `GET /livez` and does not send a bearer. `/livez` and `/readyz` stay open when tokens are configured; `GET /api/health` needs the read scope.

## Session

`--stateless` sends one `tools/call` and no session header. Use it for hosts the **user** started with `sf mcp --mcp-stateless`, not a skill-started process.

Without `--stateless`: `initialize`, capture `Mcp-Session-Id`, reuse it for `tools/call`.

Stdout is the tool JSON. Exit `0` on success, including `wait_run` with `reason: "timeout"` (keep polling). Exit `1` on transport failure or `isError: true`. Exit `2` on usage or malformed `--args` — that parse error happens before any network call.

The script's allowlist is the Host's registered MCP tool set. A name outside that set exits `2` before any network call. `node scripts/mcp-call.mjs --list-tools` asks a live Host and reports names the script does not know (`unknown_to_script`). Confirm a costly or destructive call in [SKILL.md](../SKILL.md) before you send it. `cancel_run`, `delete_run`, and `gc_runs` are allowed; `gc_runs` stays a dry run until `execute` is true.

`start_run` may return `{ "runId", "queued": true }` — treat that like `{ "runId" }` (success, slower start). `busy_capacity` means the admission queue is full; `busy_checkout` is path-bound lease only; `insufficient_disk` is a hard stop (not queued).
