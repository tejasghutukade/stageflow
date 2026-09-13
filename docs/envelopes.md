---
layout: default
title: Envelopes
---

# Envelopes

When a stage finishes, it hands off structured state to the pipeline via an **envelope**. The next stage (and the operator console) read this contract instead of scraping chat transcripts.

Envelopes are **domain-neutral** — you choose what goes in `summary`, `payload`, and `artifacts` for your workflow.

## Contract

Type definition (`src/types/envelope.ts`):

```typescript
type StageEnvelope = {
  status: "success" | "failure";
  summary: string;
  artifacts: string[];
  payload?: Record<string, unknown>;
  fork_choice?: string[];
  feedback_loop?: FeedbackLoopAction;
  stage_id?: string;
  notes?: string;
};

type FeedbackLoopAction =
  | { action: "continue" }
  | { action: "send_back"; target: string };
```

| Field | Required | Description |
|-------|----------|-------------|
| `status` | yes | `"success"` advances the pipeline. Catalog wiring is `route` on the source, not inbound `needs`. `"failure"` skip-cascades single-parent successors whose `on` does not include `failed`. Including `failed` in `on:` opts that edge out of cascade; it does not launch that successor — launch still requires a succeeded parent. A [generic fan-in](yaml-catalog.md#generic-fan-in) Join stays pending if any parent failed, even when that parent's `on` includes `failed`; the run fails. Skipped siblings do not block a Join that has a succeeded parent |
| `summary` | yes | Non-empty human-readable summary |
| `artifacts` | yes | Array of run-relative artifact paths (may be empty `[]`) |
| `payload` | no | Structured data for downstream stages; required on success (`io.output.schema` is required on every stage body) |
| `fork_choice` | no* | Immediate successor ids to run; required on success when the stage has a `fork` field |
| `feedback_loop` | no† | Continue or send-back decision; required on success when the stage declares a `{ type: loop }` route entry |
| `stage_id` | no | Optional stage id echo |
| `notes` | no | Optional free-form notes |

\* Required for fork stages on success (`fork_choice`). On failure, `fork_choice` is not required or validated. `clone_forks` is rejected on every envelope — see [Rejected clone fields](yaml-catalog.md#clonable-successors).

† Required on success for stages that declare a `{ type: loop }` route entry. Forbidden on failure and on stages that do not declare a `{ type: loop }` route entry. See [Feedback loops](#feedback-loops).

## Emitting an envelope

Stage agents call the Pi tool **`emit_stage_envelope`** exactly once when finished. The pipeline cannot advance until this succeeds.

Example success emit (conceptual):

```json
{
  "status": "success",
  "summary": "Clarified requirements and listed three open questions.",
  "artifacts": [],
  "payload": {
    "requirements": ["…"],
    "open_questions": ["…"]
  }
}
```

On `status: "failure"`, the envelope is accepted. Catalog wiring is `route` on the source, not inbound `needs`. Single-parent successors whose `on` does not include `failed` are skip-cascaded. Including `failed` in `on:` opts that edge out of cascade; it does not launch that successor — launch still requires a succeeded parent. A [generic fan-in](yaml-catalog.md#generic-fan-in) Join stays pending if any parent failed, even when that parent's `on` includes `failed`; the run fails. Skipped siblings do not block a Join that has a succeeded parent. `fork_choice` is not required or validated on failure.

Every stage body declares `io.output.schema`. On success, `payload` is validated against that JSON Schema subset — see [io schemas](#io-schemas).

### Fork stages

Catalog YAML `route` does **not** use `fork_choice`. Listed `to:` targets stay on the DAG; optional `if` can skip an edge. There is no agent exclusive pick. Do not emit `fork_choice` to select YAML successors. `fork_choice` is only validated when the resolved DAG node has a `fork` field (constructed DAGs, not catalog YAML).

If a constructed DAG node has a `fork` field, the success emit **must** include `fork_choice: string[]` naming which of those successors to run. Absent or illegal choices cause the emit to be rejected (`isError: true`); the stage fails when no valid emit follows before the session ends.

```json
{
  "status": "success",
  "summary": "Chose design-doc branch.",
  "artifacts": [],
  "fork_choice": ["design-doc"]
}
```

Rules:
- Every id in `fork_choice` must be an immediate successor of this stage.
- `fork_choice: []` is accepted only when `allow_none: true` is set with `select: subset`. `select: one` always requires exactly one choice — empty `fork_choice` fails emit even if `allow_none: true`.
- On failure, `fork_choice` is not required or validated.

Unchosen successors are `skipped` — the same status used when a parent fails. Catalog pipelines use [route](yaml-catalog.md#route) instead of `fork_choice`.

### Rejected clone fields {#clonable-successors}

`clone_forks` is not a valid envelope field. Presence fails emit with a message naming the field and pointing at a Clone Chain. See [YAML catalog — Rejected clone fields](yaml-catalog.md#clonable-successors) and [Clone Chain spec](specs/clone-chain.md). That authoring is not current runtime behavior.

### Feedback loops {#feedback-loops}

When the emitting stage's pipeline entry declares a `{ type: loop }` route entry (see [YAML catalog](yaml-catalog.md#feedback-loops)), a **successful** emit **must** include `feedback_loop`:

```json
{ "action": "continue" }
```

or

```json
{ "action": "send_back", "target": "implement" }
```

| Action | Effect |
|--------|--------|
| `continue` | Accept the stage and schedule normal successors (exit the loop / advance past the source). |
| `send_back` | Replay from `target` through the source. `target` must equal the policy's `target`. |

Rules:

- `feedback_loop` is **required** on success for a configured source; omitting it rejects the emit.
- `feedback_loop` is **not allowed** when `status` is `failure`.
- `feedback_loop` is **not allowed** on stages that do not declare a `{ type: loop }` route entry.
- `send_back` **cannot** be combined with `fork_choice` on the same envelope.
- `continue` may still carry `fork_choice` when that field is otherwise required for the stage.

On replay, agents see a **Feedback Loop Context** section (JSON) with loop/replay ids, the source's send-back envelope (summary, artifacts, payload), remaining replays, route stage ids, and optional prior-attempt / active fork-generation hints. Use that context — not scraped transcripts — to address the feedback.

After `max_replays`, behavior follows `on_max_replays` (`require_continue` or `wait_for_human`). Human decisions: [CLI](cli-reference.md#sf-runs-feedback-decide), [MCP `decide_feedback_loop`](mcp.md#decide_feedback_loop), or `POST /api/runs/:runId/stages/:stageId/feedback-decision`.

Walkthrough: [`examples/feedback-loop/`](../examples/feedback-loop/). Fixture: [`feedback-loop.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop.pipeline.yaml).

### io schemas {#io-schemas}

Every stage body must declare both `io.input.schema` and `io.output.schema`. Omitting `io`, a side, or `schema` fails load (`stage.invalid_io`). Success `payload` is required and checked against `io.output.schema` using a JSON Schema subset (`src/envelope/payloadSchema.ts`). `io.input.schema` is the same subset, used for predecessor success payloads on normal edges, and matching optional task `input` on entry stages (omitted `input` is `{}`; mismatch is an error). Sequential and fan-in edges: the child's `io.input` must be a structural subset of each parent's `io.output`; pipeline load and `sf validate` report a mismatch as `pipeline.io_incompatible`. The root must be `type: object` and cannot be `nullable`. Supported node types: `object`, `string`, `number`, `integer`, `boolean`, `array`. Keywords: `properties`, `required`, `items`, `additionalProperties` (boolean only), `minItems`, `enum` (string and integer), `minimum`, `maximum`. String nodes also accept `pattern` (a JavaScript RegExp string, unicode semantics), `minLength`, and `maxLength` (non-negative integers). Nested nodes may set `nullable: true`, compiling to a union of that type with `null`. Unknown keywords are ignored. Pipeline-file `schemas:` is the `$ref` root (`#/schemas/<name>`); see [YAML catalog — Pipeline schemas](yaml-catalog.md#pipeline-schemas).

Fixture: [`tests/fixtures/stages/name-selection.yaml`](../tests/fixtures/stages/name-selection.yaml).

### Emit-phase verify {#verify-emit}

A stage may declare emit-phase items on body `verify` — a small, in-session gate `emit_stage_envelope` itself enforces on every **success** emit, this attempt, before a candidate envelope is even captured:

```yaml
id: approve-plan
gate_kinds: [artifact_backed]
verify:
  - id: plan-approved
    type: gate
    kind: artifact_backed          # last artifact_backed exchange this attempt must be accept
  - id: plan-artifact-present
    type: artifact
    basename: implementation-plan.md  # must appear in envelope.artifacts (suffix match, no disk I/O)
    when: [emit]
system_prompt: |
  Review the plan artifact. Ask the operator to accept it, then emit success.
model: anthropic/claude-sonnet-4-5
```

| Check type | Required fields | Semantics |
| --- | --- | --- |
| `gate` | `id`, `kind` | The *last* `ask_operator` exchange of this kind **in this attempt** must satisfy it: `confirm`/`artifact_backed` need `decision: "accept"`; `free_text`/`multi_question` need any completed (answered) exchange. Default `when` is `[emit]`. |
| `artifact` with `when` including `emit` | `id`, `when`, `basename` or `path` | `basename` (or the basename of `path`) must appear in the emitted `artifacts` list, either verbatim or as a `/<basename>` path suffix. Purely a list check — no filesystem access. `type: artifact` requires `when`. |

A failing emit-phase check rejects the emit (`isError: true`, no `terminate`) so the agent can retry in the same turn; it never fails the stage outright. Checks run in declaration order and stop at the first failure. Emit-phase `verify` is skipped entirely on `status: "failure"` emits, and omitted/empty `verify` is a no-op — existing stages are unaffected.

**Not the same as after-phase `verify`.** After-phase items (`when` includes `after`) run **after** a candidate envelope has already been captured (via repair/manual recovery), and `gate`/`artifact` there are disk- and history-aware (after-phase `gate` accepts *any* accepted decision over the run so far; after-phase `artifact` does a real on-disk `lstat`/`sha256` check). See [Verified Stage Execution](verified-stage-execution.md). Emit and after may look at overlapping facts (defense in depth) as items on the same `verify` list.

## Artifacts

Use **`write_stage_artifact`** to create files under the stage attempt directory. The tool `path` is relative to `stages/<stageId>/attempts/<n>/artifacts/`:

```
stages/<stageId>/attempts/<n>/artifacts/<your-file>
```

The tool returns a **run-relative path** for `emit_stage_envelope` and `ask_operator`.

Example paths referenced in fixtures:

- `stages/plan-review/attempts/1/artifacts/plan.md`
- `stages/hitl-four-kinds/attempts/1/artifacts/summary.md`

Artifact-backed HITL gates reference these paths in `ask_operator` — see [HITL](hitl.md).

## Storage

Accepted envelopes persist in the SQLite run store (`SF_STORE=sqlite` only; see [CLI storage](cli-reference.md#storage-locations)). Artifacts still live under `stages/<stageId>/attempts/<n>/artifacts/`. CI recipes that write `envelope.json` (see [CI consumption](#ci-consumption) below) are `sf envelope get` exports, not run-workspace storage.

## Rules

1. **One advancing emit per stage attempt** — later emits are ignored after the first acceptance
2. **`artifacts` is required** — pass `[]` when there are no files
3. **`summary` must be non-empty**
4. **`ask_operator` does not complete the stage** — call `emit_stage_envelope` after gates are resolved

## Downstream consumption

Later stages receive prior envelope context through the stage bootstrap (task + upstream summaries/payloads). Exact prompt assembly is handled by the runtime; authors focus on meaningful `payload` and `summary` content.

**Keyed generic fan-in** — two or more parents list a forward `to:` to this child. Join input is `priorEnvelopesByStage`, a record keyed in YAML declaration order. `priorEnvelope` is `null`. Skipped and failed parents are omitted from join input (not synthesized). The Join does not run after a failed parent, so agents do not consume synthetic failure envelopes at the Join. See [YAML catalog — generic fan-in](yaml-catalog.md#generic-fan-in), [`examples/generic-fan-in/`](../examples/generic-fan-in/), and [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml).

Inspect envelopes in the operator console: run detail → stage → envelope view (`#/runs/<runId>/stages/<stageId>/envelope`).

MCP `get_run` returns envelope summary and artifact paths without full event streams.

### CI consumption {#ci-consumption}

In headless CI, downstream shell steps read envelopes via the CLI instead of querying SQLite or scraping transcripts.

**Raw envelope** (stage contract as emitted):

```bash
sf envelope get --from sf-run.json --stage detect-changes --format envelope --json
```

**Handoff deliverables** (normalized shape for GHA scripts — absolute artifact paths, fork skip detection):

```bash
sf envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
```

When the detect stage emits `fork_choice: []`, handoff output is `{ "skipped": true }` and downstream deliver/upload steps can no-op. Catalog YAML does not author fork; that skip shape is for constructed DAGs and the current Archify example until it is rewired.

Typical CI flow:

1. `sf run --json --include stages > sf-run.json`
2. `sf envelope get --format handoff …` → `envelope.json`
3. Shell script consumes `envelope.json` (see [`examples/archify-on-pr/`](../examples/archify-on-pr/))

Full recipe: [CI / headless](ci.md#handoff-envelope-extraction) · CLI flags: [`sf envelope get`](cli-reference.md#sf-envelope-get)

## See also

- [YAML catalog](yaml-catalog.md) — `io` on stage bodies
- [HITL](hitl.md) — gates before emit
- [Verified Stage Execution](verified-stage-execution.md) — after-phase `verify` (`when` includes `after`) is distinct from emit-phase items
- [CLI reference](cli-reference.md) — `sf envelope get`, handoff format
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — stages that exercise emit + artifacts
