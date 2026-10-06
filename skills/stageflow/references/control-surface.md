# Control surface

Prefer MCP when a Stageflow host is up. Otherwise use the CLI. This file is the only copy of that rule; job skills cite it instead of restating it.

## Probe

Run [../scripts/detect-host.mjs](../scripts/detect-host.mjs). Do not write a second probe.

```bash
node ../scripts/detect-host.mjs
node ../scripts/detect-host.mjs --base-url http://127.0.0.1:3847
```

The script `GET`s `{baseUrl}/api/health` (default `http://127.0.0.1:3847`, 1500 ms timeout). **up** means HTTP 200 and parseable JSON. Non-200, non-JSON, or timeout is **down**. Health stays Host/Origin-only (no bearer), so loopback probes keep working when a control token is configured. This probe is Stageflow host up/down only — it does not detect a coding-agent question UI. Gate presentation lives in [`../../stageflow-run/references/native-question-ui.md`](../../stageflow-run/references/native-question-ui.md).

Stdout is one line: `up <baseUrl>` or `down <baseUrl>`, with an optional trailing `bearer` when `STAGEFLOW_CONTROL_TOKEN` or `STAGEFLOW_CONTROL_TOKEN_FILE` is set in this environment (MCP/Compose need `Authorization: Bearer` — see [`../../stageflow-run/references/mcp-call.md`](../../stageflow-run/references/mcp-call.md)). Exit `0` when up, `1` when down, `2` on usage error.

**Health is not auth.** `GET /api/health` is ungated (Host/Origin only — no bearer). Do **not** treat a health 200 as authenticated MCP. Non-loopback and Compose Hosts require a drive bearer (`STAGEFLOW_CONTROL_TOKEN`); MCP and protected API calls need `Authorization: Bearer <drive-token>` when a control token is set. See Stageflow docs: MCP (Access control); Docker and self-hosting — Local try.

Start a host with `sf ui` or `sf mcp` when the user wants MCP. Do not auto-start one. Compose local try is the standing-Host path — see `stageflow-setup` and Stageflow docs: Docker and self-hosting.

## When the host is up

Use MCP tools over the Streamable HTTP endpoint at `{baseUrl}/mcp`. Send `Authorization: Bearer <drive-token>` when `STAGEFLOW_CONTROL_TOKEN` (or a named drive token) is configured. Tool names and payloads live in Stageflow docs: MCP (checkout: [docs/mcp.md](../../../docs/mcp.md)). Typical talking-job tools: `list_pipelines`, `list_tasks`, `start_run`, `run_stage`, `get_run`, `wait_run`, `list_waiting`, `answer_gate`, `decide_feedback_loop`, `get_envelope`, `read_artifact`, `list_checkout_changes`, `get_run_diff`, `read_checkout_file`, `validate`, `describe_pipeline`, `get_health`, `list_providers`, `list_models`, `list_project_mcp`, `probe_project_mcp`, `export_run`, `list_skills`, `list_stage_events`, `get_stage_verification`.

`get_health` returns capacity fields plus `stageflow_home`, `boot_providers` / `providers_live` (prefer `list_providers` for live auth), and an on-demand `disk` breakdown (`runs_bytes`, `worktrees_bytes`, `repos_bytes`, `state_db_bytes`, `a2a_artifacts_bytes`, `free_bytes`) for the durable root. When `slotsAvailable` is `0`, starts may still succeed as queued until `STAGEFLOW_MAX_QUEUED` is full — see `start_run` in the MCP docs.

**Skills cwd ≠ catalog root:** `STAGEFLOW_OPERATOR_CWD` resolves operator skills; MCP/HTTP catalog browse uses seeded ∪ registered `project_root` values. See Stageflow docs: MCP — Skills cwd vs catalog project_root.

Some capabilities stay **CLI-only** (or `docker exec` on a container Host): `sf graph`, `sf migrate-yaml`, `sf skills install` (durable host install; prefer `start_run.skills` for harnesses), A2A config mutate/validate, and provider OAuth login. Provider API keys for Host boot use `STAGEFLOW_PROVIDER_<ID>_API_KEY(_FILE)`, not an MCP login tool. Use the MCP **CLI-only capabilities** decision table (Stageflow docs: MCP) instead of inventing MCP substitutes.

## When the host is down

Use the `sf` CLI. Command names and flags live in Stageflow docs: CLI reference (checkout: [docs/cli-reference.md](../../../docs/cli-reference.md)). Typical talking-job commands: `sf run`, `sf runs waiting`, `sf runs answer`, `sf runs feedback-decide`, `sf runs wait`, `sf validate`, `sf envelope get`, `sf artifact read`, `sf providers`.

Probe before each mutating `sf runs` verb. If the probe is **up** or the command refuses because a host is up, continue that gate via MCP — do not start a second mutating writer, and do not start `sf mcp` as a disposable bridge.
