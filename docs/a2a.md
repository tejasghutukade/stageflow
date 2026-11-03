# A2A server

Stageflow can expose explicitly published pipelines as [A2A](https://a2a-protocol.org/v1.0.0/specification/) capabilities that other agents invoke over JSON-RPC. This is the inbound direction only: a caller supplies input to an existing pipeline, and Stageflow creates a run and tracks it as an A2A task. See `docs/plans/2026-09-15-a2a-server-plan.md` for the full design; this page is the operator-facing reference.

## Status

Implemented: discovery (Agent Card, per-publication contracts), publication validation with drift detection, durable at-most-once run submission, invoke/poll/results, caller-answerable clarification gates, result freezing with opaque artifact downloads, per-caller rate limiting and admission caps, and terminal-task/message retention.

Not implemented: streaming (`SendStreamingMessage`/`SubscribeToTask`), active pipeline cancellation (`CancelTask` always returns a documented non-cancelable error), push notifications, and public (unauthenticated) discovery.

## Enabling the host

A2A is turned on by an `a2a.yaml` the Host finds, in this order:

1. `STAGEFLOW_A2A_CONFIG`, an explicit path (a file outside the project, or a migration from an earlier setup).
2. `a2a.yaml` at the project root, next to `stageflow.yaml`, when it exists.
3. `$STAGEFLOW_HOME/a2a.yaml`, the host-level file, when it exists. Like `connections.yaml`, it is not tied to a project folder.

If none exists, A2A is disabled. The management API and `sf a2a enable` create the host-level file when no file is found, and otherwise write to the file that was found. They always write absolute `project_root` values, so the file works from any location. A file written by the API is plain YAML in the format below; comments in a file the API edits are not kept.

```bash
export STAGEFLOW_A2A_CONFIG=/etc/stageflow/a2a.yaml
```

Changes made through the management API or the `sf a2a` commands below take effect at once, with no restart. A file you edit by hand is loaded at startup, and again when you run `sf a2a reload` (or `POST /api/a2a/reload`). A reload that fails (a typo, a missing token) keeps the configuration already in use and records the failure in `GET /api/a2a/status`; it never takes A2A down. Publication drift (below) is still checked on every new invocation.

### Manage A2A from the CLI or the API

These commands talk to the running Host (and start one when none is running). `--json` prints the API response.

```bash
sf a2a enable [--public-url https://agents.example.com]   # create the config; no callers or publications yet
sf a2a caller create procurement-assistant                # prints the token once
sf a2a publication create supplier.publication.yaml       # body below; --json for the API response
sf a2a publication edit supplier_assessment edit.yaml     # only the fields you give change
sf a2a publication remove supplier_assessment
sf a2a caller revoke procurement-assistant
sf a2a caller list | publication list | status | reload
```

`enable` needs a public URL: pass `--public-url`, or set `STAGEFLOW_PUBLIC_URL` (the file then carries no `public_url` and follows the variable). Turning A2A on adds no callers and publishes nothing. Nothing is exposed until an operator creates a caller and a publication that names it.

A caller created this way has a token the Host generates: 24 random bytes, hex-encoded (48 characters). It is printed once, in the response that creates it, and is never returned again by any route, log or error. The Host stores only the SHA-256 digest of the token, in the `a2a-caller.<id>` entry of `channel-secrets.json` (owner-only file, credential root), and the caller's `a2a.yaml` entry is `token_store: a2a-caller.<id>`. A lost token cannot be shown again: revoke the caller and create a new one.

Revoking a caller removes it from `callers` and from every publication's `allowed_callers`, deletes its stored digest, and its token stops working on the next request. A task the caller started before it was revoked is unaffected by the change. Creating a caller whose id still has retained tasks (they are deleted 30 days after they finish) is refused, so a new caller cannot read an old caller's results; use another id.

Tasks that started before a change keep the settings they started with: the result stage, whether the payload is included, the exposed artifacts and the caller-answerable stages are recorded on the task when it is created. Editing or removing a publication, or revoking its caller, never turns a running task into a failure.

The older file-based commands still work:

```bash
sf a2a add-caller procurement-assistant [--config ./a2a.yaml] [--token-env NAME]
```

This writes the caller's `id` and a `token_env` name to the file and prints a token to export. A running Host reads `token_env` variables only at startup, so use `sf a2a caller create` for a caller that must work without a restart. Exactly one of `token_env` or `token_store` is set per caller.

Validate a configuration file locally without touching a running daemon. `--config` is optional on both and follows the same discovery rule as the host:

```bash
sf a2a validate [--config ./a2a.yaml]
sf a2a list [--config ./a2a.yaml]
```

`callers` and `publications` may be empty, and a publication may have no `allowed_callers`; such a publication is served to nobody.

The console does the same from the **A2A** screen; see [Console: A2A](console-a2a.md).

### Management API

All routes are under `/api/a2a` on the Host. They use the same control tokens as the other Host API routes: `GET` needs the `read` scope, every other method needs `drive`. Errors are `{ "error": "<message>", "code": "<code>" }`. Bodies are JSON, up to 64 KiB.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/a2a/status` | | `{ state: "disabled" \| "enabled" \| "configuration_error", configPath?, error?, publicUrl?, agentCardUrl?, callers?, publications?, lastReload?: { ok, at, error? } }` |
| `POST /api/a2a/enable` | `{ public_url? }` | `200` status. Creates the file if there is none; otherwise loads it. `400 a2a_public_url_required` when no public URL is given or set |
| `POST /api/a2a/disable` | | `200` status (`state: "disabled"`, `configPath` kept). Writes `enabled: false` to the file and keeps callers, publications and stored token digests; the A2A endpoints answer `404` as when disabled. `409 a2a_not_enabled` when there is no file. Calling it when already off is a no-op |
| `POST /api/a2a/reload` | | `200` status; `409 a2a_reload_failed` (the old configuration stays in use) |
| `GET /api/a2a/callers` | | `{ callers: [{ id, token_source: "store" \| "env" }] }` |
| `POST /api/a2a/callers` | `{ id }` | `201 { id, token, token_source: "store" }` (the only time the token appears). `409 a2a_not_enabled`, `a2a_caller_exists`, `a2a_caller_id_retained` |
| `DELETE /api/a2a/callers/:id` | | `{ revoked: true, removed_from: [publicationId] }`; `404 a2a_caller_not_found` |
| `GET /api/a2a/publications` | | `{ publications: [Publication] }` |
| `GET /api/a2a/publications/:id` | | `Publication` plus `contract: { revision, inputSchema, outputSchema, artifacts }`; `404 a2a_publication_not_found` |
| `GET /api/catalog/files?project_root=<id>&ext=.json` | | `{ project_root, ext, files: [path], truncated }`. Read scope. Relative paths of files with that extension under the catalog project, sorted; `node_modules`, `.git` and symbolic links are skipped, at most 500 are returned (`truncated: true` when there are more). The console lists input schema files with it. `400 invalid_extension`, `unknown_project_root` |
| `GET /api/a2a/pipeline-stages?project_root=<id>&pipeline=<path>` | | `{ stages: [{ id, terminal, artifacts, freeTextOnly }] }`. `terminal` marks the stages a publication may use as `results.stage`; `artifacts` are the files that terminal stage declares (what `results.artifacts` may name); `freeTextOnly` marks the stages `caller_answerable_stages` may name. Same rules as publication validation. `400 a2a_path_invalid`, `a2a_publication_invalid` |
| `POST /api/a2a/publications/preview` | Publication body | `contract`, without saving. `400` with the validation message |
| `POST /api/a2a/publications` | Publication body | `201 Publication`. `409 a2a_publication_exists`; `400 a2a_unknown_caller`, `a2a_path_invalid`, `a2a_publication_invalid` |
| `PATCH /api/a2a/publications/:id` | any subset of the body (`results` merges by key) | `Publication`. `id` cannot change |
| `DELETE /api/a2a/publications/:id` | | `{ removed: true }` |

A Publication is `{ id, name, description, project_root, pipeline, goal, repository?, ref?, allowed_callers, input_schema, results: { stage, include_payload, artifacts }, caller_answerable_stages, revision? }`. In the API, `project_root` is a catalog project (the id the console shows) and `pipeline` and `input_schema` are paths inside it; absolute paths and paths that leave the project are refused. `allowed_callers` must name existing callers. Each change is written to the file, loaded, and rolled back if the result does not load.

Turning off is kept across restarts. While off, the routes that change callers or publications answer `409 a2a_not_enabled`; `POST /api/a2a/enable` removes `enabled: false` and loads the file again, which restores the callers, publications and tokens as they were. A file with `enabled: false` otherwise still validates.

`GET /api/a2a/status` returns the same object the Host health report carries under `a2a`.

## Publication configuration

`a2a.yaml` is a separate, operator-owned file — publishing a pipeline never changes its own YAML.

```yaml
version: 1
public_url: https://agents.example.com
callers:
  - id: procurement-assistant
    token_env: PROCUREMENT_TOKEN   # or: token_store: a2a-caller.procurement-assistant
publications:
  - id: supplier_assessment
    name: Assess a supplier
    description: Research a supplier against purchasing requirements.
    project_root: /srv/projects/procurement
    pipeline: ./pipelines/supplier-assessment.pipeline.yaml
    goal: Produce an evidence-backed supplier assessment.
    allowed_callers: [procurement-assistant]
    input_schema: ./contracts/supplier-request.schema.json
    results:
      stage: final_report
      include_payload: true
      artifacts: [assessment.md]
    caller_answerable_stages: [clarify_requirements]
```

- `public_url` must be an HTTPS origin (HTTP is allowed on loopback). When it is omitted, the Host's `STAGEFLOW_PUBLIC_URL` is used as the default and validated the same way; an explicit `public_url` always wins. The agent card interface URL and the contract and artifact links use it.
- `project_root`, `pipeline`, and `input_schema` resolve relative to the config file, then to each other; they are canonicalized at load time.
- Only listed publications are served — nothing is auto-published from the catalog.
- `results.stage` must be a single, non-cloned terminal stage. Its declared artifacts must have a matching `artifact_declared` pre-emit check in the pipeline.
- `caller_answerable_stages` may only name stages whose only gate kind is `free_text`. Mixed or `confirm`/`multi_question`/`artifact_backed` gates stay operator-only — split a stage before exposing it if it mixes clarification with approval.
- A caller has exactly one of `token_env` (the named environment variable, read when the configuration is loaded, at least 32 characters) or `token_store` (a credential store entry holding the SHA-256 digest of a Host-generated token). A token never appears in YAML, and tokens must be unique per caller.
- Every publication is pinned to a digest of its resolved pipeline body, referenced stage files, and input schema. A later edit that changes that digest fails new invocations with a drift error instead of silently running a changed recipe — republish (run `sf a2a reload`, or save the publication through the API) to pick it up.

## Request contract

Discovery: `GET /.well-known/agent-card.json` (authenticated; the Agent Card lists only the publications the caller may invoke) and `GET /a2a/contracts/:publicationId` (business input schema, output schema, declared artifact names).

Invocation is a normal A2A `SendMessage` call whose message carries one structured data part:

```json
{
  "contractVersion": 1,
  "operation": "invoke",
  "capability": "supplier_assessment",
  "input": { "supplier": "Northstar Packaging" }
}
```

Answering a caller-answerable clarification question is another `SendMessage`, addressed to the existing task (`message.taskId`), with the opaque prompt handle from the last `GetTask`/`SendMessage` response:

```json
{
  "contractVersion": 1,
  "operation": "answer",
  "prompt": "<opaque handle from the task's status message>",
  "answer": { "kind": "free_text", "text": "Yes, certification is mandatory." }
}
```

`GetTask`/`ListTasks` return normal A2A `Task` objects. A completed task's `artifacts` array holds a `result` entry (a data part with the configured payload, when `include_payload` is set) plus one entry per named file artifact, each carrying a `url` part pointing at `GET /a2a/artifacts/:taskId/:artifactId` (authenticated, opaque ID — never a filesystem path).

## Task states

| Task state | Meaning |
|---|---|
| `submitted` | Accepted; the run has not yet reported activity |
| `working` | Run active, or waiting on an operator-only gate |
| `input-required` | One or more caller-answerable questions are pending; the status message's data part lists `{ handle, message }` per question |
| `completed` | Verified result frozen; artifacts are immutable from here |
| `failed` | Run failed, or the result contract could not be satisfied (e.g. a declared artifact was never produced) |

`CancelTask` always resolves with the SDK's `TaskNotCancelableError` (`-32002`) — Stageflow does not claim to stop an in-flight run. Retry with a new message under the same context for a fresh attempt.

## `run_stage`: wildcard-access standalone stage/pipeline calls

Everything above this section is the explicit-publication model: nothing is reachable unless an operator wrote it into `a2a.yaml`'s `publications` list and named the caller in `allowed_callers`. `run_stage` is a second, deliberately different operation that bypasses that model entirely. Any caller with a valid bearer token for the host (any caller in `a2a.yaml`'s `callers` list, regardless of what — if anything — is published to them) can run **any** catalog or inline stage or pipeline through it, exactly the same wildcard-access default the standalone `run_stage` MCP tool and CLI give a local harness. This is a deliberate, temporary trade-off for proving out standalone stage execution, not a hardened access-control surface — do not expose a host with real callers over an untrusted network expecting `run_stage` to be gated the way `invoke` is. A resend of a `run_stage` message under a fresh `messageId` but identical content lands on the same task/run rather than starting a duplicate, the same at-most-once guarantee `invoke` gives (see [Limits and retention](#limits-and-retention) below).

The message carries one structured data part, mirroring the MCP tool's call shape:

```json
{
  "contractVersion": 1,
  "operation": "run_stage",
  "stage": "stages/final_report.yaml",
  "task": { "id": "t-1", "goal": "Assess Northstar", "input": { "supplier": "Northstar" } },
  "blocking": true
}
```

- Exactly one of `stage` (a catalog stage path, or an inline stage body object) or `pipeline` (a catalog pipeline path, or an inline `{ id, stages: [...] }` definition) is required. `stage` is synthesized into a one-stage pipeline internally, the same way the MCP `run_stage` tool does it.
- Exactly one of `task_path`, `task` (an inline task object), or `envelope_ref` is required for input — the same three shapes `run_stage` accepts over MCP. `envelope_ref` is either a single `{ runId, stageId, attempt? }` or an **array** of them, and resolves previously stored `StageEnvelope`s from **any** run this host knows about, standalone or pipeline. A single reference: its `summary` becomes the new call's `goal`, its `payload` becomes `input` verbatim. Multiple references: each resolved `payload` is namespaced under its `stageId` in `input` (disambiguated by `runId` only if two references share a `stageId`), and summaries are combined into `goal`. Artifacts are not auto-copied — read them yourself via `GET /a2a/artifacts/:taskId/:artifactId` on the task that produced them and inline whatever you need into the next call's `task.input`.
- Optional `checkout` (only meaningful with `envelope_ref`), `model` (overrides the stage's own declared model for this call only), and `timeout_ms`.
- `blocking: true` waits for the run to reach a terminal or waiting state on the server before the `SendMessage` response comes back, so a caller that doesn't want to poll `GetTask` gets a single-round-trip result up to `timeout_ms`. Omit it (or pass `false`) for the normal async A2A shape: the response reflects whatever state the run is in immediately (usually `submitted`/`working`), and the caller polls `GetTask` the same way it would for `invoke`.
- The response is a normal A2A `Task`, using the same states as `invoke` (`submitted`/`working`/`input-required`/`completed`/`failed`). Its `metadata.runId` is the run id to hand to a later `run_stage` call's `envelope_ref` — this is the only place a run id is ever exposed over A2A; `invoke`'s published-capability tasks keep it opaque, unchanged.
- HITL relay reuses `invoke`'s existing `input-required`/`answer` mechanics with no new protocol: a stage waiting on a `free_text` gate surfaces as `input-required` with an opaque prompt handle, answered with the existing `operation: "answer"` message against the task id. There is no per-stage `caller_answerable_stages` allowlist to configure — the caller who started a `run_stage` task already owns that whole ad hoc run outright, so any of its own `free_text` prompts are answerable; a `confirm`/`multi_question`/`artifact_backed` gate stays out of reach exactly like it does for `invoke`.
- A `stage` call's result mirrors the publication `results` shape (`summary`/`payload`/artifacts), except every artifact the stage produced is exposed, not a configured subset. A `pipeline` call has no single designated result stage, so its `result.payload.stages` is an array of `{ stageId, status, summary, payload }` for every stage in the run instead of one envelope.

## Limits and retention

| Setting | Default |
|---|---|
| Request body | 1 MiB |
| Rate limit | 60 requests/minute per caller, burst of 20 (in-memory token bucket, per daemon process) |
| Admission | 2 nonterminal tasks per caller, in addition to the global run-capacity/checkout leases |
| Terminal retention | Completed/failed tasks and their frozen artifacts are deleted 30 days after they finished |
| Message tombstones | Deduplication records for a given message ID are kept 90 days, then a resend of that ID is treated as new |

Retention runs on an hourly sweep while the host is up (`A2aHost.pruneExpired`); nothing is deleted eagerly on every request. Nonterminal tasks are never auto-deleted — a stuck task is an operator-visible signal, not silent cleanup.

## Deploying behind a gateway

The Stageflow daemon stays loopback-bound. For remote callers, put an HTTPS reverse proxy in front and forward **only**:

- `/.well-known/agent-card.json`
- `/a2a` (the JSON-RPC endpoint)
- `/a2a/contracts/*`
- `/a2a/artifacts/*`

Never forward `/api/*`, `/mcp`, provider login routes, or any console/static asset route — those are local operator/administration surfaces, not part of the published contract. Terminate TLS at the gateway; Stageflow authenticates every A2A request again with its own bearer tokens, so a gateway that only does TLS termination (no additional trust) is sufficient. If the gateway does inject its own identity, treat that as a separate, explicit trust decision — Stageflow does not infer caller identity from network position.

Example (nginx, illustrative):

```nginx
location = /.well-known/agent-card.json { proxy_pass http://127.0.0.1:PORT; }
location /a2a { proxy_pass http://127.0.0.1:PORT; }
# everything else (/api, /mcp, ...) is intentionally not proxied
```

## Walkthrough

1. An operator authors `clarify_requirements -> research -> review -> final_report`, validates it, and deploys it.
2. The operator publishes `supplier_assessment` (in the console API, the CLI or `a2a.yaml`), granting `procurement-assistant` permission to invoke it and to answer only `clarify_requirements`.
3. The caller reads the Agent Card and the publication's contract, then sends message `m-1` with Northstar's details. Stageflow creates task `t-1` and run `r-1`.
4. The HTTP response is lost; the caller resends `m-1`. Stageflow returns the same `t-1` — the durable submission key guarantees at most one run per accepted message content.
5. `clarify_requirements` asks whether certification is mandatory. `GetTask` reports `input-required` with an opaque handle.
6. The caller answers with `operation: "answer"` against `t-1`. Stageflow resumes independently of the HTTP connection.
7. `review` waits for a human approval gate. The caller sees `working` and cannot answer it — the operator approves through the existing console or MCP interface.
8. `final_report` passes verification. Stageflow freezes its payload and `assessment.md`, then marks `t-1` `completed`.
9. The caller downloads the report with its own credentials. A different caller cannot discover `t-1` or its artifact — `GetTask`/artifact reads for another caller's task behave as not-found.

## Testing

`tests/a2a.*.test.ts` exercise the registry, the HTTP/JSON-RPC transport (using the real `@a2a-js/sdk` client), durable submission identity, and the admission/rate/retention limits above against fake execution backends — no paid model calls are required.
