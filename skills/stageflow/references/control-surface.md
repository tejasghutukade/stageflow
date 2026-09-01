# Control surface

Prefer MCP when a Stageflow host is up. Otherwise use the CLI. This file is the only copy of that rule; job skills cite it instead of restating it.

## Probe

Run [../scripts/detect-host.mjs](../scripts/detect-host.mjs). Do not write a second probe.

```bash
node ../scripts/detect-host.mjs
node ../scripts/detect-host.mjs --base-url http://127.0.0.1:3847
```

The script `GET`s `{baseUrl}/api/health` (default `http://127.0.0.1:3847`, 1500 ms timeout). **up** means HTTP 200 and parseable JSON. Non-200, non-JSON, or timeout is **down**. This probe is Stageflow host up/down only — it does not detect a coding-agent question UI. Gate presentation lives in [`../../stageflow-run/references/native-question-ui.md`](../../stageflow-run/references/native-question-ui.md).

Stdout is one line: `up <baseUrl>` or `down <baseUrl>`. Exit `0` when up, `1` when down, `2` on usage error.

Start a host with `sf ui` or `sf mcp` when the user wants MCP. Do not auto-start one.

## When the host is up

Use MCP tools over the Streamable HTTP endpoint at `{baseUrl}/mcp`. Tool names and payloads live in [docs/mcp.md](../../../docs/mcp.md). Typical talking-job tools: `list_pipelines`, `list_tasks`, `start_run`, `get_run`, `wait_run`, `list_waiting`, `answer_gate`, `get_envelope`, `read_artifact`, `validate`, `get_health`.

## When the host is down

Use the `sf` CLI. Command names and flags live in [docs/cli-reference.md](../../../docs/cli-reference.md). Typical talking-job commands: `sf run`, `sf validate`, `sf envelope get`, `sf artifact read`, `sf providers`.
