# mcp-call

Use [`../scripts/mcp-call.mjs`](../scripts/mcp-call.mjs) when the Stageflow host is up and this harness has no native Stageflow MCP tools. Do not start `sf mcp` from this skill.

```
node scripts/mcp-call.mjs --base-url <url> --tool <name> --args '<json>' [--stateless]
```

Default `--base-url` is `http://127.0.0.1:3847`. `--args` defaults to `{}`.

`--stateless` sends one `tools/call` and no session header. Use it for hosts the **user** started with `sf mcp --mcp-stateless`, not a skill-started process.

Without `--stateless`: `initialize`, capture `Mcp-Session-Id`, reuse it for `tools/call`.

Stdout is the tool JSON. Exit `0` on success, including `wait_run` with `reason: "timeout"` (keep polling). Exit `1` on transport failure or `isError: true`. Exit `2` on usage or malformed `--args` — that parse error happens before any network call.

Allowed `--tool` names (see [`docs/mcp.md`](../../../docs/mcp.md)): `list_pipelines`, `list_tasks`, `start_run`, `get_run`, `wait_run`, `list_waiting`, `list_runs`, `answer_gate`, `decide_feedback_loop`, `read_artifact`, `list_checkout_changes`, `get_run_diff`, `read_checkout_file`, `describe_pipeline`, `validate`, `list_providers`, `list_models`, `list_project_mcp`, `probe_project_mcp`, `get_health`.

`start_run` may return `{ "runId", "queued": true }` — treat that like `{ "runId" }` (success, slower start). `busy_capacity` means the admission queue is full; `insufficient_disk` is a hard stop (not queued). Do not call `cancel_run`, `delete_run`, or `gc_runs` from this skill.
