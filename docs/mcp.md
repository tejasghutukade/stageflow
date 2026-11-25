---
layout: default
title: Mcp
---

# MCP

Stageflow serves **Streamable HTTP** MCP with **stateful sessions as the product default**. Host it via either:

- `sf ui` — operator console + MCP
- `sf mcp` — headless: same console REST API + MCP, minus the static console assets (no browser)

Default endpoint:

```
http://127.0.0.1:3847/mcp
```

The URL is printed on boot. Point Cursor or another MCP client at this URL while the host process is alive.

Stage agents consuming author-declared MCP is a different surface. Operator-host MCP can list catalog models and list or probe the project's `.mcp.json` servers and the servers saved from the console (Settings → Project MCP) the same way Settings and HTTP do; inspect is not attach. YAML `mcp:` still allowlists what a stage receives. See [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp). Adding servers and secrets from the console, OAuth sign-in and who may fill `${VAR}` are covered in [MCP servers](mcp-servers.md).

**Breaking (Slot 6):** stage `.mcp.json` `${VAR}` interpolation resolves against the curated stage environment only — not Host ambient env. Declare tokens in `secrets:` (often `as: env`) or use `${VAR:-default}`. A secret saved from the console can be declared in `secrets:` too; it then fills `${VAR}` in the stage's MCP servers only and is never placed in the stage environment. See [migration-stage-environment.md](migration-stage-environment.md).

## Sessions (how MCP works)

1. Client `POST /mcp` with an `initialize` request (no session header).
2. Server responds with an `Mcp-Session-Id` header.
3. Client opens `GET /mcp` with that header for the SSE listen channel (server→client notifications).
4. Subsequent tool / resource calls reuse the same session header on `POST /mcp`.
5. `DELETE /mcp` with the session header closes the session.

Sessions enable run **resource subscribe** and `notifications/resources/updated`. Without a GET listen stream, tools still work on the session; push updates will not be delivered.

`createHttpHost` applies a shared Host/Origin allow-list (see [Access control](#access-control)) on `/mcp` and every `/api/*` route. Absent `Origin` is allowed on ordinary routes; a present `Origin` must match the allow-list. Point clients at the advertised URL printed on boot (or the console Settings → MCP endpoint).

### Backup, export, and restore

Backup and whole-store restore stay on the HTTP API (drive token). Per-run export is available over MCP and HTTP; whole-instance export remains HTTP-only:

- `POST /api/backup` / `GET /api/backup/<name>` — drive scope (archives may contain credentials)
- MCP `get_run` with `view: export` / `GET /api/runs/<id>/export` — read scope (single-run `projectRun` + `run_manifest`)
- `GET /api/runs/<id>/debug-bundle` — read scope (capped redacted post-mortem; CLI `sf debug-run`; no MCP tool)
- `GET /api/export` — read scope (NDJSON whole-instance export)
- `POST /api/restore` — drive scope; stages a restore and drains the Host

See [Docker and self-hosting](docker.md) and [CLI reference](cli-reference.md).

### Access control

| Env | Role |
|-----|------|
| `STAGEFLOW_ALLOWED_HOSTS` | Extra hostnames/IPs (optional `:port`). Unset → loopback only. Loopback always allowed. `*` rejected. |
| `STAGEFLOW_CONTROL_TOKEN` / `_FILE` | Bearer **drive** scope (implies read). `caller_id` **`default`**. Required when bind is non-loopback (or any named drive token). |
| `STAGEFLOW_CONTROL_TOKEN_<NAME>` / `_FILE` | Named **drive** token. `caller_id` is `<NAME>` lowercased. `NAME` must not be empty or `FILE` (so `_FILE` stays the default-token file pointer). |
| `STAGEFLOW_READ_TOKEN` / `_FILE` | Bearer **read** scope only (`caller_id` **`default`**). Singular — there is no `READ_TOKEN_<NAME>`. |

Send `Authorization: Bearer <token>` on protected requests. The Host digests the presented bearer once and compares it against **every** configured token digest (constant-time; no early-return oracle).

**Named tokens are attribution and quota only — not isolation.** Any valid drive token can still read or mutate any `run_id`. Do not treat `caller_id` as a tenancy boundary.

Optional host `config.yaml` quotas (after global capacity reserve; distinct from per-project reject):

```yaml
callers:
  ci_github:
    max_concurrent: 2
  default:
    max_concurrent: 1
```

When a caller is at its quota but the Host still has global slots, the start is **queued** and success may include `queuedCode: "busy_caller_quota"`. If the admission queue (`STAGEFLOW_MAX_QUEUED`) is also full, start fails with `code: "busy_caller_quota"` (≠ `busy_capacity`). Per-project caps still **reject** with `busy_capacity` + `scope: "project"` and never queue. Global queue-full remains `busy_capacity`.

CLI starts are unattributed (`surface: cli`, null `caller_id`). MCP/REST stamp `caller_id` from the authenticated bearer only — never from body, query, or tool args. `get_run` (omit `runId`) / `GET /api/runs?caller_id=` filter by stored attribution.

| Surface | Scope |
|---------|-------|
| `GET`/`HEAD` `/api/*` | `read` |
| Mutating `/api/*` (`POST`/`PUT`/`PATCH`/`DELETE`) | `drive` |
| `/mcp` (any method) | `drive` |
| `GET /api/health` | `read` (a missing bearer is 401). Open probes: `/livez`, `/readyz`, `/api/auth-hint`, `/api/console-login` |
| A2A (`/a2a*`, agent card) | Unchanged (own per-caller tokens) |
| Static console files | Ungated |

Missing/malformed credentials → `401` + `WWW-Authenticate: Bearer`. Valid token, wrong scope → `403`. Host/Origin failures → `403` before bearer checks.

For curl, scripts, and MCP client `headers`, export the drive token from the Host's file (the CLI reads the same path when the env vars are unset):

```bash
export STAGEFLOW_CONTROL_TOKEN="$(tr -d '\n' < "${STAGEFLOW_HOME:-$HOME/.stageflow}/control-token")"
# or
export STAGEFLOW_CONTROL_TOKEN_FILE="${STAGEFLOW_HOME:-$HOME/.stageflow}/control-token"
```

Omit `Authorization` on `/api/*` and `/mcp` only when the Host started with `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1`. A normal `sf ui` or `sf mcp` start writes a token; `/livez` and `/readyz` stay open without one.

If `STAGEFLOW_CONTROL_TOKEN` and `_FILE` are unset, the Host reuses `$STAGEFLOW_HOME/control-token` when that file is a regular file owned by the current user, mode `0600`, and the token is valid. It mints a new token only when the file is missing or not reusable (for example mode `0644`, a symlink, or another owner), and it writes the file only after listen succeeds. `Control token: <token>` is printed when this process mints a token, including when stdout is not a terminal. A reused file prints `Control token file: <path>` only. The detached service child does not print the value. A second `sf ui` or `sf mcp` that finds this Host already answering the port exits 0 without replacing the file, and `sf ui` opens the console signed in. Another program, a Host using another data directory, or an older Stageflow Host on the port makes it exit 1 with a message that names which. That bearer is required on `/api/*` and `/mcp`. `/livez` and `/readyz` stay open, as do `/api/auth-hint` (the token file path, loopback callers only) and `/api/console-login` (the one-time code exchange, loopback callers only). The CLI reads the file when the env var is unset. A stage does not receive the control token. Its cache, temporary and working directories are inside the data directory (`~/.stageflow` by default, `/data` in Docker), and an unsandboxed stage runs as your user, so it can find and read the token file. Use the stage container sandbox (`STAGEFLOW_STAGE_CONTAINER_IMAGE`) when a stage runs untrusted code. Never put the token in stage `secrets:`. `STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND=1` is an explicit opt-in to start a non-loopback bind with no token. The shipped Compose file does not set it; it publishes the port on `127.0.0.1` only, the process inside binds `0.0.0.0`, and the token file is `/data/control-token` inside the container. Leave the opt-in unset when the port is reachable beyond this machine. An `Origin`, when present, must match the `Host` header's host and port. Prefer `sf mcp` in containers with `STAGEFLOW_BIND=0.0.0.0` and `STAGEFLOW_ALLOWED_HOSTS` set to the public hostname. See [migration-stage-environment.md](migration-stage-environment.md).

### Stateless escape hatch (test/debug)

For clients or harnesses that must avoid session headers:

```bash
sf mcp --mcp-stateless
# or
STAGEFLOW_MCP_STATELESS=1 sf mcp
```

Same flag/env applies to `sf ui`. Stateless mode uses per-request create/teardown (`sessionIdGenerator: undefined`). Every tool call — including the long-poll `wait_run` — works in both session and stateless modes, since each is still a single request/response. Resource **subscribe/notify** requires session mode + GET SSE listen.

## `sf mcp` vs `sf ui`

| Host | Serves | Browser |
|------|--------|---------|
| `sf ui` | Console REST/static + `/mcp` | Opens by default |
| `sf mcp` | Console REST (no static assets) + `/mcp` | No |

`sf mcp` mounts the **same** `createOperatorRoutes` surface as `sf ui` — every `/api/*` route is available on both; only the console's static files are omitted. Both hosts apply the [access control](#access-control) Host/Origin allow-list and bearer token to `/mcp` and `/api/*`. A Host start with no operator token generates one. `/livez` and `/readyz` stay open.

Both use the same **global durable-root** run store (`$STAGEFLOW_HOME`, default `~/.stageflow/`) and default port `3847` on the shared global service. Catalog membership is **seeded ∪ registered** roots under that store — not the shell cwd where you started the Host. Run **either** `sf ui` **or** `sf mcp` at a time. A second start on the same port finds the Host already up, prints that, and exits without replacing the control token. Different ports against the same store with two managers is unsupported. `sf run` / `sf run-stage` / mutating `sf runs` verbs also auto-start this service headlessly if nothing is listening yet. See [Data directory](data-directory.md) and [Catalog roots](#catalog-roots-and-project_root).

MCP tools browse pipelines/tasks under those catalog roots and persist runs in the global durable root — not the Host process boot cwd.

Implementation: `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/resources.ts`, and domain `*Tools.ts` modules. Every Host tool registers through `withToolDefaults` (`defineTool.ts`): annotations come from `TOOL_META` risk; `tools/list` input schemas omit `$schema`; descriptions must not name REST routes (registration throws if a description contains `/api/`). Run polling, artifacts, checkout, and tail helpers live in `src/runread/` (also used by HTTP, CLI, A2A, and evals).

> **Breaking change (pipeline-owned catalog):** `list_catalog` with `kind: pipelines` returns manifest filesystem path listings (objects with `path`, `id`, …), not bare pipeline ids. `start_run` requires a `pipeline` path and exactly one of `task_path` or inline `task`. Update MCP clients that passed ids like `"hello"`.

## Resources

### `stageflow://runs/{runId}`

Runs-only resource template. Catalog discovery stays on `list_catalog` with `kind: pipelines` / `list_catalog` with `kind: tasks` tools — there is **no** `stageflow://catalog/pipelines` resource in v1.

| Operation | Notes |
|-----------|-------|
| `resources/list` | Enumerates known runs as `stageflow://runs/{runId}` |
| `resources/read` | JSON text of the lean `get_run` projection (no stage events) |
| `resources/subscribe` | Session mode + GET SSE; receive `notifications/resources/updated` |

**When `updated` fires:** run created; run `status` changes; waiting fields appear or clear (HITL park / resume). Not on every stage activity log line.

### Dual observation paths (permanent)

| Path | Mechanism |
|------|-----------|
| `wait_run` | Poll-inside-wait tool; works without sessions / without the change bus |
| Resource subscribe | Push via GET SSE; complementary, not a replacement for `wait_run` |

Compose either way:

```
start_run → wait_run (until waiting/any) → answer_gate → wait_run (until terminal)
```

```
start_run → wait_run (until waiting/any) → decide_feedback_loop → wait_run (until terminal)
```

```
start_run → resources/subscribe(stageflow://runs/{runId}) → on updated, get_run / answer_gate / decide_feedback_loop
```

## Catalog roots and `project_root` {#catalog-roots-and-project_root}

The Host is machine-global under `$STAGEFLOW_HOME`. Catalog roots are:

| Kind | Wire `project_root` | Notes |
|------|---------------------|-------|
| `registered` | Absolute filesystem path | Durable rows in the store projects registry (ensure / past-run backfill) |
| `workspace` | `workspace` | `$STAGEFLOW_HOME/workspace`, always present; on a new install it holds the [starter pipelines](quickstart.md#starter-pipelines) once a provider is connected |
| `seeded` | Symbolic id | Read-only catalogs a Host is configured with. The packaged Host has none |

There is **no** mandatory `boot` catalog root from Host cwd. Cold Host with an empty registry lists the workspace root only.

**Path contract (MCP / remote HTTP / A2A sharing the helper):**

- Pipeline/task paths must be **catalog-relative** under a known root (absolute pipeline/task paths → `absolute_path_not_allowed`). Error body keeps `code` + `registered_roots` and explains the remedy: relative under `project_root`; local CLI may pass absolute paths and auto-register.
- Unknown absolute `project_root` → `unknown_project_root` (listing and path resolution agree; the Host does **not** invent a request-scoped root).
- `..` / realpath escape of the selected root → `path_outside_project_root`.

**MCP vs CLI paths:** MCP/HTTP require catalog-relative paths under `project_root`. Local CLI may pass absolute paths and auto-registers the project folder.

**Registration:** Trusted local clients (CLI / loopback + control token) call `POST /api/projects` with `{ "project_root": "/abs/path" }` to ensure a folder into the registry. Remote MCP and non-loopback HTTP cannot ensure arbitrary paths (`ensure_project_not_allowed`). After ensure, remotes may `start_run` with that absolute `project_root` and catalog-relative paths. Local `sf run` ensure-then-starts automatically — see [CLI reference](cli-reference.md#sf-run).

**Browse requirements:** `list_catalog` with `kind: pipelines` / `list_catalog` with `kind: tasks` need a **registered or seeded** root with a readable `stageflow.yaml` at that root. Git is **not** required for discovery — a non-git folder with a manifest browses the same way after ensure.

### Skills cwd vs catalog `project_root` {#skills-cwd-vs-catalog-project-root}

`STAGEFLOW_OPERATOR_CWD` (and the operator skills catalog) is the Host's skill-resolution checkout — set before the service first starts. It is **not** the same as catalog membership or MCP `project_root`. Pipelines and tasks list under **seeded ∪ registered** roots (`stageflow.yaml` at each root). Skills resolve under the operator cwd; listing and `start_run` paths resolve under the selected catalog `project_root`.

## Tools

The Host exposes **60** MCP tools. The previous 124 per-endpoint names are removed with no aliases. Merged tools pick behavior with flat fields:

### Toolsets {#toolsets}

Each tool belongs to one **toolset**. A client that connects to `/mcp` with no `toolsets` query receives only the **core** toolset (17 tools: discover, author pipelines and tasks, start and watch runs, read outputs, wait, answer gates, cancel a runaway run, and decide a feedback-loop wait). Add named toolsets with a `toolsets` query on the MCP URL; **core is always included**.

| Toolset | Role |
|---------|------|
| `core` | Always loaded (see above) |
| `runs` | Abandon stages, delete runs, garbage-collect |
| `catalog` | Import tasks, probe project MCP servers |
| `agents` | Project agent CRUD, chat, approvals |
| `evals` | Eval and dataset authoring, runs, review, triage |
| `functions` | Reusable JavaScript functions |
| `triggers` | Trigger CRUD and fire |
| `connections` | Host send channels |
| `memories` | Host memories and cards |
| `artifacts` | Publish, read and delete artifacts. Off unless the URL asks for it, same as `functions` and `memories` |

**Parse rules.** `toolsets` is comma-separated; names are trimmed and lowercased; duplicates collapse. An empty or missing value means core only. `all` anywhere selects every toolset (all 61 tools). Repeated `toolsets` parameters merge. Any unknown name fails the whole request with HTTP **400** and a JSON-RPC error body `{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "…" }, "id": null }` listing valid names (`core`, the table above, and `all`).

**Session binding.** The selection is fixed when a **stateful** session starts at `initialize`. Later requests on that session ignore their query string — sending `?toolsets=all` on a follow-up `tools/list` or `tools/call` does **not** upgrade a core-only session. Open a **new** session (new `initialize` against a URL that includes the toolsets you need), or use the reconnect URL from `get_started`. In **stateless** mode (`sf mcp --mcp-stateless`), each request is parsed again. Toolsets are not permissions: they only change what the external MCP endpoint registers for that session. The toolkit recorder, agent grants, Guide, and eval gates still see the full registry.

**Discovery.** On a partial session, `get_started` lists unloaded toolsets with titles and a reconnect URL that adds each toolset. Call `get_started` after connect when the client only loaded core.

**Console.** Settings → **MCP server** lists toolsets from the same catalog the agent permissions picker uses. Core is always on; check optional toolsets to build the URL and `.cursor/mcp.json` snippet. The URL is not persisted — copy it into the client and reconnect to apply.

The 17 core tool names are: `get_started`, `list_catalog`, `validate`, `read_pipeline`, `write_pipeline`, `write_stage`, `write_task`, `start_run`, `get_run`, `get_stage`, `run_files`, `wait_run`, `stage_action`, `cancel_run`, `list_waiting`, `answer_gate`, `decide_feedback_loop`.

| Field | Role |
|-------|------|
| `kind` | Catalog listing or validation target (`list_catalog`, `validate`) |
| `view` | Read projection on a resource (`get_run`, `get_stage`, `run_files`, `read_pipeline`, agent/function/eval reads) |
| `action` | Operation on a merged write tool (`stage_action`, `save_dataset`, `review_eval_results`, `decide_agent_action`) |
| `mode` | `create` or `update` on every `save_*` and `write_*` tool |

A **grant** or eval reference to a tool name covers **every mode** of that tool (for example `start_run` includes pipeline start, stage start, and rerun). The old→new map is `src/toolkit/toolRenames.ts`.

### Tool list shape (MCP clients) {#tool-list-shape}

`tools/list` annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) come from `TOOL_META.risk` (`read` / `write` / `destructive` / `external`). Listed `inputSchema` values have no `$schema` key. Tool descriptions say what the tool does; they do not cite `/api/*`. Size and shape are guarded by `tests/mcp.toolsList.test.ts`.

### Agent tools {#agent-tools}

Project agents use the same service as [Agent API](agent-api.md#routes). Errors return `{ "code", "message", "issues"? }` with stable `agent.*` codes.

| Tool | Input | Notes |
|------|-------|-------|
| `get_agent` | `list: true` **or** `id` + optional `view` (`definition`, `revisions`, `revision`, `diff`) | List agents or read one |
| `validate` | `kind: agent`, `definition` or `eval_id` path | Does not save |
| `save_agent` | `mode: create` **or** `mode: update` (+ `baseRevision`, `from_revision` to restore) | Create is always disabled |
| `set_agent_enabled` | `id`, `enabled: true` \| `false` | |
| `archive_agent` | `{ id }` | |
| `agent_chat` | `{ id, message, sessionId? }` | External; waits for the reply |
| `get_agent_session` | `list: true` **or** `id` + `sessionId` / list filters | Transcript and approvals |
| `stop_agent_session` | `{ id, sessionId }` | |
| `decide_agent_action` | `action: approve` \| `deny`, `id`, `sessionId` | Operator-only (`gates.decide`) |

See [Agents](agents.md) and [Agent API — CLI, MCP and REST](agent-api.md#cli-mcp-and-rest-side-by-side).

### Function tools {#function-tools}

| Tool | Grant | Notes |
|------|-------|-------|
| `get_function` | `functions.read` | `list: true` or `id`; optional `view: revisions` \| `revision` |
| `save_function` | `functions.write` | `mode: create` \| `update`; `copy_from` duplicates |
| `test_function` | `functions.test` | Mock by default; `real: true` for live resources |
| `delete_function` | `functions.cleanup` | Refuses while referenced |

Attaching functions still goes through `write_stage`, `write_pipeline`, and `save_agent`. See [Functions](functions.md) and [function-api](function-api.md).

### Eval tools {#eval-tools}

Eval MCP tools use optional `project_root`. Mocks and graders keyed on tool name cover every mode of a merged tool; see [Evals](evals.md).

| Tool | Notes |
|------|-------|
| `get_eval` | `list: true` or `eval_id` + `view` (`definition`, `calibrations`) |
| `validate` | `kind: eval` or inline `yaml` |
| `save_eval` | `mode: create` \| `update`; `source: sample` installs the sample |
| `save_dataset` | `action: create` \| `ops` \| `convert` |
| `get_eval_run` | list or `eval_run_id`; `view: export` for export |
| `get_eval_results` | table or `case_id` for one row |
| `review_eval_results` | `action: label` \| `accept` \| `dismiss` on failure suggestions |
| `get_eval_failures` | `view: suggestions` \| `sort_status` |
| `run_eval`, `try_eval_case`, `sort_eval_failures`, `calibrate_eval_grader` | External / may cost money |
| `cancel_eval_run`, `delete_eval_run` | |

### Catalog discovery and validation

| Tool | Modes |
|------|-------|
| `get_started` | Operator orientation (read, operator-only) |
| `list_catalog` | `kind`: `pipelines`, `tasks`, `skills`, `models`, `providers`, `mcp_servers`, `health` |
| `validate` | `kind`: catalog paths, `draft`, `agent`, `eval`, `connection_recipient`; `preflight: true` for live checks |
| `read_pipeline` | `view: package` (default) or `dag` |
| `write_pipeline` | `mode: create` \| `update` |
| `write_stage` | `mode: create`, `patch: true`, `no_pipeline: true`, or `form: content` update |
| `write_task` | `mode: create` \| `update`; `no_pipeline: true` for standalone tasks |
| `import_task` | GitHub issue → task (external) |
| `probe_project_mcp` | Connect probe (external) |

Workshop Author profile tools keep names like `write_pipeline` with `mode: create` and `write_stage` with `patch: true`; they are not Host MCP tools.

### Runs, files, and control

| Tool | Modes |
|------|-------|
| `start_run` | Exactly one of `pipeline`, `stage`, or `from_run` (+ task shapes as before) |
| `get_run` | Omit `runId` to list; `view: export` to export |
| `get_stage` | `view`: `events`, `log`, `envelope`, `verification` |
| `run_files` | `view`: `artifact`, `changes`, `diff`, `file` |
| `wait_run` | Long-poll until terminal or waiting |
| `stage_action` | `action`: `retry`, `resume`, `recover`, `stop_recovery` |
| `cancel_run`, `abandon_stage` | Destructive cleanup |
| `delete_runs` | One `runId` or `gc: true` (+ `execute` to apply GC) |
| `list_waiting` | `detail: full` (default) or `summary` |

### Gates {#decide_feedback_loop}

`answer_gate` and `decide_feedback_loop` stay separate tools (operator-only, `gates.decide`). See [HITL](hitl.md).

**`answer_gate`** — deliver an operator answer for a waiting stage (`runId`, `stageId`, `answer` matching the prompt kind).

**`decide_feedback_loop`** {#decide_feedback_loop} — resolve a feedback-loop `wait_for_human` decision (`decision`: `extend` \| `continue` \| `abandon`, optional `loopId`, `reason`).

Compose with `wait_run`: when `waiting_kind` is `feedback_loop_decision`, call `decide_feedback_loop`; otherwise `answer_gate`.

### Triggers, connections, memories

| Tool | Notes |
|------|-------|
| `get_trigger` | list or `id` |
| `save_trigger` | `mode: create` \| `update`; `enabled_only` toggles enablement |
| `fire_trigger` | External |
| `get_connection` | Lists connections |
| `save_connection` | `mode: create` \| `update` |
| `test_connection`, `remove_connection` | |
| `get_memory` | list or `id` |
| `save_memory` | `mode: create` \| `update`; `card: true` replaces one card |
| `delete_memory_card` | Destructive |

### Artifact tools {#artifact-tools}

Toolset `artifacts`. A bare `/mcp` session does not load it. Groups: `artifacts.read` (read), `artifacts.write` (write), `artifacts.refresh` (external), `artifacts.cleanup` (destructive).

| Tool | Grant | Parameters and result |
|------|-------|------------------------|
| `get_artifact` | `artifacts.read` | `list: true` with `kind`, `owner`, `tag`, `status` (`available` or `expired`), `live`, `sort` (`updated`, `title`, `size`), `order`, `project_root`, `limit` (1–100, default 50), `cursor`. Returns `{ artifacts, next_cursor }`. `q` is passed to the same list search as the index (title, description, tags, summary, id, and owner). Or `key` (`<ownerKey>/<id>`) with `view`: `record` (default; optional `version`), `versions`, `content`, `data`. `content` returns text for text kinds, capped at 200 KiB on a character boundary with `truncated` and `size_bytes` (the full size). Images include `base64` only at or under 256 KiB; larger images return `artifact.content_too_large_for_mcp` (use the console or CLI). `data` on `live.declarative` returns `{ status, snapshots, last_refreshed_at, last_error_code, errors, truncated }` and does not run functions. Snapshot JSON is capped at 200 KiB. Over the cap, the largest values are dropped first: those snapshots have `truncated: true`, `value: null`, and `size_bytes`. A static artifact is `artifact.not_live`. An expired artifact is `artifact.content_unavailable`. Hidden artifacts are omitted. |
| `save_artifact` | `artifacts.write` | Same body as publish: `owner` (`stage` with `pipeline` and `stage`, or `agent` with `agent`), `project_root`, `id`, `kind`, `title`, optional `description`, `tags`, `summary`, and `content` or `content_base64`. `live.declarative` and `live.html` also take `manifest`. Returns `{ key, version, unchanged, project_root }`. The same bytes keep the version. Source stored is `mcp`. Same size and shape caps as publish. |
| `refresh_artifact` | `artifacts.refresh` | External. `key`, optional `project_root`, optional `binding_ids` (REST refresh uses `bindingIds`). Runs the live bindings and returns `{ status, snapshots, last_refreshed_at, last_error_code, errors, truncated }`. Snapshots may include `source` (`executed` or `cache`). A full executor queue adds `retry_after_seconds` (30). `ifStale` is a REST and CLI option, not an MCP argument. Snapshot values share the 200 KiB cap; a dropped value is `null` with per-snapshot `truncated: true` and `size_bytes`. A static artifact is `artifact.not_live`. An expired artifact is `artifact.content_unavailable`. |
| `delete_artifact` | `artifacts.cleanup` | `key`, optional `project_root`. Removes every version. Irreversible. An indexed artifact is `artifact.not_deletable`. |

There is no tool to approve or revoke declared live HTML origins. That is deliberate: only an operator can approve, from the console or `sf artifact approve-origins`. `save_artifact` can publish a manifest that declares origins. Those origins stay blocked until a person approves them. A publish with declared origins returns a warning that they need approval in the console before they take effect.

Read calls do not write. `project_root` is the catalog wire id, and omitting it when the owner and id exist in more than one project returns `artifact.ambiguous` with `project_roots`.

| Code | When |
|------|------|
| `artifact.invalid_id` | id or key is missing, contains `::`, or is not a slug |
| `artifact.invalid_kind` | kind is not a static kind |
| `artifact.invalid_shape` | body failed validation (`issues` lists paths) |
| `artifact.invalid_filter` | `sort`, `order`, `kind`, `tag`, `live`, or `status` is not a list filter |
| `artifact.too_large` | content is over 5 MiB |
| `artifact.not_found` | key or version does not exist, including a hidden artifact |
| `artifact.ambiguous` | owner and id exist in several projects and `project_root` was omitted (`project_roots`) |
| `artifact.not_deletable` | delete of an indexed artifact |
| `artifact.not_live` | `view: data` |
| `artifact.content_too_large_for_mcp` | image content over 256 KiB |
| `artifact.store_unavailable` | the index database is not open |
| `invalid_arguments` | the tool arguments failed the input schema |

Full parameter and REST parity for each family remain in [Agent API](agent-api.md), [Evals HTTP API](evals.md#http-api), and [function-api](function-api.md). The rename table in `docs/plans/2026-11-14-1206-refactor-mcp-tool-consolidation-plan.md` lists every old name.

## Cursor configuration

Add an MCP server entry pointing at the Streamable HTTP URL while `sf ui` or `sf mcp` runs. Use **Settings → MCP server** to copy the URL with your toolset choices, or start from bare `/mcp` for core only. For example:

```json
{
  "mcpServers": {
    "stageflow": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

Exact config shape depends on your MCP client version. Prefer session-capable Streamable HTTP clients. Use `--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` only for test/debug clients that cannot send session headers. The host rejects non-localhost `Origin` / `Host`, so use `127.0.0.1` (or `localhost`) in the URL.

## Error codes

Network errors from `/mcp` and `/api/*` include a stable snake_case `code` alongside the human `error` message. Minimum codes:

| Code | Meaning |
|------|---------|
| `unknown_project_root` | Filter or path targeted a root outside registered ∪ seeded (no invent) |
| `absolute_path_not_allowed` | Absolute path from a network caller |
| `path_outside_project_root` | `..` or realpath escape of the selected root |
| `catalog_root_unreadable` | Root listed but not readable |
| `ensure_project_not_allowed` | `POST /api/projects` from remote / non-trusted client |
| `config_invalid` / `config_unknown_key` | HostConfig validation |
| `provider_not_configured` | Boot/provider credential failure |
| `a2a_configuration_error` | A2A registry/config failed |
| `untrusted_config_origin` | Workspace config refused |
| `command_not_on_path` | Doctor / MCP command missing |
| `not_ready` | `/readyz` failing check |
| `busy_capacity` / `busy_checkout` / `aborted` | Unchanged admission codes |
| `EVAL_*`, `FILE_CHANGED`, `DATASET_NOT_FOUND` | Eval request errors (`EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_ENGINE_UNAVAILABLE`, `EVAL_NODE_TOO_OLD`, `EVAL_NOT_FOUND`, `EVAL_RUN_NOT_FOUND`). See [Eval tools](#eval-tools) |
| `invalid_arguments` | Merged-tool argument / mode rejection (`isError: true` tool text `{ code, message, status: 400 }`) before the handler runs |
| `internal_error` | Uncoded internal failure |

## CLI-only capabilities (decision table)

In a container, anything that is CLI-only means `docker exec`. A remote harness holding a control token cannot run those commands. This table is the negative surface: what is deliberately **not** an MCP tool, why, and what to use instead. Literal `docker exec` lines for every exec-only row live in [Docker and self-hosting — CLI via docker exec](docker.md#cli-via-docker-exec).

| Capability | Decision | Reason / substitute |
|------------|----------|---------------------|
| `sf graph` | **Not MCP.** Use `read_pipeline` with `view: dag` (definition DAG) or `get_run` / `pipeline_track` (per-run shape). | `sf graph` is a human terminal ASCII render of the same resolved DAG. A second rendering tool would spend MCP context on data the harness already has as JSON. |
| `sf migrate-yaml` | **`docker exec` / laptop only.** | Rewrites checkout YAML in place and shells `git status` to refuse dirty trees. An API that mutates a caller's repository from a request crosses the "repository content is untrusted input" line. Authors migrate before commit. |
| `sf skills install` | **`docker exec` / image bake only** for durable host skills. Prefer **run-scoped skills** on `start_run` (`skills` param) for harnesses. | Install copies into `.pi/skills` on disk (operator or derived-image path). Harnesses should ship skill bytes with the start call — not install into the container. Use `list_catalog` with `kind: skills` to inspect resolution (run \| checkout \| host). |
| `sf eval engine install` | **`docker exec` / laptop only** (the Docker image bakes the engine in). | It runs `npm install` of a ~1.2 GB package into `$STAGEFLOW_HOME/eval-engine/`. A network call that installs software is not something a tool request should trigger. A missing engine makes `run_eval` fail `EVAL_ENGINE_UNAVAILABLE`. |
| `sf a2a validate` / `list` / `add-caller` | **`docker exec` only** for file-based validate and `add-caller`. Read surface: `GET /api/a2a/status` (`read` scope). | These read or write the deployment file directly. |
| `sf a2a enable` / `caller` / `publication` / `reload` | **Not MCP.** HTTP management API under `/api/a2a` (`read` for GET, `drive` otherwise), also reachable from the CLI. See [A2A — management API](a2a.md#management-api). | Changes apply live (no restart). A caller token is returned once, so it is a console/CLI action, not a tool result an agent harness would keep. |
| Provider login — API key | **No MCP login tool.** Configure at Host boot via `STAGEFLOW_PROVIDER_<ID>_API_KEY` / `_FILE` ([Providers](providers.md#non-interactive-host-boot-credentials)). | Container path is env/file at boot (Slot 7), not an interactive MCP call. `list_catalog` with `kind: providers` remains read-only inspect. |
| Provider login — OAuth | **`docker exec` only.** | Terminal- or browser-driven flow; no headless paste-code API. Once-per-deployment operator action. |
| `sf export-run` / `sf debug-run` | **Remote when Host is up:** MCP `get_run` with `view: export` and HTTP `GET /api/runs/<id>/export` (read) for a single-run export. Debug bundle: HTTP `GET /api/runs/<id>/debug-bundle` (read) or CLI `sf debug-run` (no MCP tool). Whole-instance: `GET /api/export`. | CLI/`docker exec` remains available for scripts or when the Host is down. |

There is no MCP `exec`, web terminal, or shell tool — `docker exec` is the supported operator escape hatch ([Docker](docker.md#cli-via-docker-exec)).

## Limitations

- Cancel signals workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included; use `cancel_run` for run-level cancel (`wait_run` abort cancels only the wait; `abandon_stage` is per running stage only)
- `start_run` with `stage` access is unrestricted for any authenticated caller of this host (no publish/allowlist step); it has no `start_run` with `from_run` support (no stored `pipeline_path`, the same constraint an inline `start_run` pipeline has)
- REST `POST /api/runs` is path-pipeline-only; inline pipelines are MCP-only (see `start_run` REST asymmetry)
- No catalog listing resource in v1 (use `list_catalog` with `kind: pipelines` / `list_catalog` with `kind: tasks` / `list_catalog` with `kind: models`)
- No provider login/logout/OAuth, settings-write, or Stage MCP attach MCP tools (`list_catalog` with `kind: providers`, `list_catalog` with `kind: models`, and `list_catalog` with `kind: mcp_servers` are read-only catalog inspect; `probe_project_mcp` connects outbound and carries `external` annotations). Catalog writes are `write_task` with `mode: create` and `no_pipeline: true`, `write_task` with `mode: update` and `no_pipeline: true`, `import_task`, `write_stage` with `mode: create` and `no_pipeline: true`, `write_stage` with `mode: update`, `form: content`, and `validate` with `kind: draft`, plus the pipeline package tools. See [CLI-only capabilities](#cli-only-capabilities-decision-table)
- No MCP tool for debug-bundle / `sf debug-run` (use HTTP `GET /api/runs/<id>/debug-bundle` or CLI)
- Default `get_run` / run resource read stay lean (no stage event streams or verification evidence) and include `total_cost_usd` plus per-stage `cost_usd` / `definition_id` when the store has them; use `get_stage` with `view: events`, `log`, `envelope`, or `verification` for detail
- Tools return JSON text content blocks, except `run_files` with `view: artifact`, which may return an MCP image content block for known image extensions
- One MCP/UI host per project root (do not run `sf ui` and `sf mcp` as peer writers)

## See also

- [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp) — project `.mcp.json`, Settings inspect, and stage `mcp` names (not this host)
- [Operator console](operator-console.md) — starts MCP alongside the UI
- [HITL](hitl.md) — gate kinds and answer shapes
- [CLI reference](cli-reference.md) — `sf ui`, `sf mcp`, `sf validate`, `sf run-stage` (the 1:1 CLI counterpart of `start_run` with `stage`), and host-down `sf runs` (inspect / wait / answer / feedback-decide / retry / resume / abandon / cancel / delete / gc / rerun). CLI `sf runs` is not a 1:1 MCP tool list; it does not clone catalog listing (`list_catalog` with `kind: pipelines` / `list_catalog` with `kind: tasks` / `read_pipeline` with `view: dag`).
- [Docker and self-hosting](docker.md#cli-via-docker-exec) — literal `docker exec` for CLI-only ops and worktree escape hatch
- [YAML catalog — Feedback loops](yaml-catalog.md#feedback-loops) — `feedback_loop` / `replay_safe` policy
- [CI / headless](ci.md) — MCP not used in CI jobs
- [Envelopes](envelopes.md) — artifact paths returned by `get_run` / `get_stage` with `view: envelope`
