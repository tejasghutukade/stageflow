# mcp-call

Use [`../scripts/mcp-call.mjs`](../scripts/mcp-call.mjs) when the Stageflow host is up and this harness has no native Stageflow MCP tools. Do not start `sf mcp` from this skill.

```
node scripts/mcp-call.mjs --base-url <url> --tool <name> --args '<json>' [--stateless]
```

Default `--base-url` is `http://127.0.0.1:3847`. `--args` defaults to `{}`.

`--stateless` sends one `tools/call` and no session header. Use it for hosts the **user** started with `sf mcp --mcp-stateless`, not a skill-started process.

Without `--stateless`: `initialize`, capture `Mcp-Session-Id`, reuse it for `tools/call`.

Stdout is the tool JSON. Exit `0` on success, including `wait_run` with `reason: "timeout"` (keep polling). Exit `1` on transport failure or `isError: true`. Exit `2` on usage or malformed `--args` — that parse error happens before any network call.

Allowed `--tool` names (see [`docs/mcp.md`](../../../docs/mcp.md)): `list_pipelines`, `list_tasks`, `start_run`, `get_run`, `wait_run`, `list_waiting`, `answer_gate`, `get_health`.
