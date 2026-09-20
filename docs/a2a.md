# A2A server

Stageflow can expose explicitly published pipelines as [A2A](https://a2a-protocol.org/v1.0.0/specification/) capabilities that other agents invoke over JSON-RPC. This is the inbound direction only: a caller supplies input to an existing pipeline, and Stageflow creates a run and tracks it as an A2A task. See `docs/plans/2026-09-15-a2a-server-plan.md` for the full design; this page is the operator-facing reference.

## Status

Implemented: discovery (Agent Card, per-publication contracts), publication validation with drift detection, durable at-most-once run submission, invoke/poll/results, caller-answerable clarification gates, result freezing with opaque artifact downloads, per-caller rate limiting and admission caps, and terminal-task/message retention.

Not implemented: streaming (`SendStreamingMessage`/`SubscribeToTask`), active pipeline cancellation (`CancelTask` always returns a documented non-cancelable error), push notifications, and public (unauthenticated) discovery.

## Enabling the host

Drop an `a2a.yaml` file at the project root, next to `stageflow.yaml` — the daemon auto-discovers it, the same way it already auto-discovers the pipeline catalog. No environment variable, no flag; if the file isn't there, A2A is simply disabled.

`STAGEFLOW_A2A_CONFIG` still works as an explicit override, for a config file that lives outside the project (or during migration from an earlier setup):

```bash
export STAGEFLOW_A2A_CONFIG=/etc/stageflow/a2a.yaml
```

Either way, the host reads the file once at startup — there is no hot reload. Editing `a2a.yaml` (or a publication's pipeline) requires an explicit restart to take effect; the drift check described below exists precisely to stop a live edit from silently taking effect without one.

Register a caller without hand-editing YAML or hand-generating a token:

```bash
sf a2a add-caller procurement-assistant
# Generated a token for caller "procurement-assistant". Export it before starting the host
# (or store it in your secrets manager):
#   export PROCUREMENT_ASSISTANT_TOKEN=<64 hex chars>
```

This only writes the caller's `id` and `token_env` name to `a2a.yaml` — never a secret value. Granting that caller access to a specific publication is still a separate, explicit edit to that publication's `allowed_callers`, on purpose: creating a caller identity and authorizing it to invoke something are different facts, and auto-granting access as a side effect would undercut "nothing is exposed unless a human wrote it down."

Validate a configuration locally without touching a running daemon — `--config` is optional on both and follows the same auto-discovery rule as the host:

```bash
sf a2a validate [--config ./a2a.yaml]
sf a2a list [--config ./a2a.yaml]
```

`GET /api/a2a/status` on the local host reports `{ state: "disabled" | "enabled" | "configuration_error", configPath? }` so operators can tell whether a running daemon actually picked up a config change (it needs a restart).

## Publication configuration

`a2a.yaml` is a separate, operator-owned file — publishing a pipeline never changes its own YAML.

```yaml
version: 1
public_url: https://agents.example.com
callers:
  - id: procurement-assistant
    token_env: PROCUREMENT_TOKEN
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

- `project_root`, `pipeline`, and `input_schema` resolve relative to the config file, then to each other; they are canonicalized at load time.
- Only listed publications are served — nothing is auto-published from the catalog.
- `results.stage` must be a single, non-cloned terminal stage. Its declared artifacts must have a matching `artifact_declared` pre-emit check in the pipeline.
- `caller_answerable_stages` may only name stages whose only gate kind is `free_text`. Mixed or `confirm`/`multi_question`/`artifact_backed` gates stay operator-only — split a stage before exposing it if it mixes clarification with approval.
- Bearer tokens are read from the named environment variable at load time (never written into YAML), must be at least 32 characters, and must be unique per caller.
- Every publication is pinned to a digest of its resolved pipeline body, referenced stage files, and input schema. A later edit that changes that digest fails new invocations with a drift error instead of silently running a changed recipe — republish (restart the daemon with the updated files) to pick it up.

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
2. The operator publishes `supplier_assessment` in `a2a.yaml`, granting `procurement-assistant` permission to invoke it and to answer only `clarify_requirements`.
3. The caller reads the Agent Card and the publication's contract, then sends message `m-1` with Northstar's details. Stageflow creates task `t-1` and run `r-1`.
4. The HTTP response is lost; the caller resends `m-1`. Stageflow returns the same `t-1` — the durable submission key guarantees at most one run per accepted message content.
5. `clarify_requirements` asks whether certification is mandatory. `GetTask` reports `input-required` with an opaque handle.
6. The caller answers with `operation: "answer"` against `t-1`. Stageflow resumes independently of the HTTP connection.
7. `review` waits for a human approval gate. The caller sees `working` and cannot answer it — the operator approves through the existing console or MCP interface.
8. `final_report` passes verification. Stageflow freezes its payload and `assessment.md`, then marks `t-1` `completed`.
9. The caller downloads the report with its own credentials. A different caller cannot discover `t-1` or its artifact — `GetTask`/artifact reads for another caller's task behave as not-found.

## Testing

`tests/a2a.*.test.ts` exercise the registry, the HTTP/JSON-RPC transport (using the real `@a2a-js/sdk` client), durable submission identity, and the admission/rate/retention limits above against fake execution backends — no paid model calls are required.
