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
  clone_forks?: CloneForkItem[];
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
| `status` | yes | `"success"` advances the pipeline. `"failure"` on a named stage skips successors whose `needs` do not accept `failed` (legacy scalar `needs` accepts `succeeded` only). A [generic fan-in](yaml-catalog.md#generic-fan-in) join that lists `failed` in that parent's `on` set continues. A parallel clone failure lets sibling clones finish and skips the clone-list join and its descendants |
| `summary` | yes | Non-empty human-readable summary |
| `artifacts` | yes | Array of run-relative artifact paths (may be empty `[]`) |
| `payload` | no | Structured data for downstream stages; required on success when the stage declares `io.output.schema` |
| `fork_choice` | no* | Non-clonable immediate successor ids to run; required on success when the stage has a `fork` field and at least one non-clonable child |
| `clone_forks` | no* | Clone actions for clonable successors; required on success when any immediate successor is `clonable`; illegal items are rejected by emit |
| `feedback_loop` | no† | Continue or send-back decision; required on success when the stage declares `feedback_loop` policy |
| `stage_id` | no | Optional stage id echo |
| `notes` | no | Optional free-form notes |

\* Required for fork stages on success (`fork_choice`) and when any immediate successor is clonable (`clone_forks`). On failure, neither field is required or validated. Extra `clone_forks` is ignored only when the emitting stage has no clonable children; if any clonable child exists, `clone_forks` must cover every clonable successor exactly once (extra `successor_id`s are rejected).

† Required on success for stages with a configured `feedback_loop` policy. Forbidden on failure and on stages without that policy. See [Feedback loops](#feedback-loops).

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

On `status: "failure"`, the envelope is accepted. A named-stage failure skips paths whose dependency contract rejects `failed`. Independent siblings and [generic fan-in](yaml-catalog.md#generic-fan-in) joins that list `failed` in that parent's `on` set continue. A parallel clone failure does not stop sibling clones; the clone-list join successor and its descendants are skipped. Sequential clone failure skips remaining clones of that successor and the clone-list join. Neither `fork_choice` nor `clone_forks` is required or validated on failure.

If the stage declares `io.output.schema` in YAML, `payload` is validated against that JSON Schema subset on success — see [io schemas](#io-schemas).

### Fork stages

Catalog YAML `route` does **not** use `fork_choice`. Listed `to:` targets always run; do not emit `fork_choice` to pick YAML successors. `fork_choice` is only validated when the resolved DAG node has a `fork` field (not produced from catalog YAML).

If a constructed DAG node has a `fork` field and at least one non-clonable child, the success emit **must** include `fork_choice: string[]` naming which of those successors to run. A fork parent whose every child is clonable does not require `fork_choice`. Absent or illegal choices cause the emit to be rejected (`isError: true`); the stage fails when no valid emit follows before the session ends.

```json
{
  "status": "success",
  "summary": "Chose design-doc branch.",
  "artifacts": [],
  "fork_choice": ["design-doc"]
}
```

Rules:
- Every id in `fork_choice` must be a non-clonable immediate successor of this stage.
- `fork_choice: []` is accepted only when `allow_none: true` is set with `select: subset`. `select: one` always requires exactly one choice — empty `fork_choice` fails emit even if `allow_none: true`.
- On failure, `fork_choice` is not required or validated.

Unchosen successors are `skipped` — the same status used when a parent fails. Catalog pipelines use [unconditional fan-out](yaml-catalog.md#route) instead of `fork_choice`.

### Clonable successors {#clonable-successors}

If any immediate successor is `clonable: true`, the success emit **must** include `clone_forks`. Tokens are `skip` | `once` | `fanout` unless the parent declares `clone_actions` (a non-empty subset). Omit `clone_actions` to keep all three. `once` is not fan-out of 1; `fanout` N is 2 through `clone_cap`. See [YAML catalog](yaml-catalog.md#clonable-successors).

The user prompt and emit tool both name the legal successor ids, clone caps, allowed actions, and each successor's assignment schema. `successor_id` is an enum of those ids. Invented ids, an empty `clone_forks` list, a disallowed action, or an assignment payload that fails `io.input.schema` stay in-session (`isError`, no `terminate`).

Item shape (exact coverage of every clonable successor):

| `action` | Required | Forbidden |
|----------|----------|-----------|
| `skip` | `successor_id`, `action` | `envelope`, `mode`, `clones` |
| `once` | `successor_id`, `action`, `envelope` | `mode`, `clones` |
| `fanout` | `successor_id`, `action`, `mode`, `clones` (length in `[2, clone_cap]`) | top-level `envelope` |

Nested `clone_forks[i].envelope` (for `once`) and `clones[j].envelope` (for `fanout`) are full `StageEnvelope` objects: they require `status`, `summary`, and `artifacts`, and may include `payload`. After the parent emits, that nested envelope becomes the clone child's prior envelope (the child reads it like any predecessor).

```json
{
  "status": "success",
  "summary": "Fan-out author-diagrams.",
  "artifacts": [],
  "clone_forks": [
    {
      "successor_id": "author-diagrams",
      "action": "fanout",
      "mode": "parallel",
      "clones": [
        { "envelope": { "status": "success", "summary": "clone 1", "artifacts": [] } },
        { "envelope": { "status": "success", "summary": "clone 2", "artifacts": [] } }
      ]
    }
  ]
}
```

Illegal items are rejected by emit. A successor may declare `io.input.schema` (same JSON Schema subset as `io.output.schema`). That schema validates `envelope.payload` — assignment fields belong there, not at the top level of the `clone_forks` item. Parent emit checks `once` and `fanout` assignment payloads against it. Omit the field to skip the assignment-payload check. Never validate clone briefs against the child's output `io.output.schema`. `skip` does not need an assignment payload.

Sequential vs parallel join: in **parallel**, sibling clones still finish after a failure, but the join successor and its descendants are skipped unless every clone succeeded. In **sequential**, the first failure skips remaining clones of that successor and the join successor does not run.

`clone_forks` is required for each clonable successor. When the parent also has `fork`, `fork_choice` names only non-clonable siblings. A fork parent whose every child is clonable does not require `fork_choice`. See [`clone-fanout-mix.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-mix.pipeline.yaml) and [`examples/clonable-fanout/`](../examples/clonable-fanout/) scenario F.

A clone may skip / once / fan-out its next stage only when that successor is clonable. Extra `clone_forks` is ignored only when the emitting stage has no clonable children (for example a nested clone whose successor is a non-clonable join). If any clonable child exists, `clone_forks` must list every clonable successor exactly once; extra `successor_id`s are rejected. See [`clonable-nested-gate.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-gate.pipeline.yaml) and [`examples/clonable-fanout/`](../examples/clonable-fanout/). Two clones fanning out the same successor is unsupported in v1 because instance ids are `{catalogId}~{n}`. Dual-parent nested fan-out is fail-closed at apply.

After fan-out, workspace paths and `--stage` keys use the instance id (`{catalogId}~{n}`); run-once keeps the catalog id. See [YAML catalog — instance ids](yaml-catalog.md#clonable-instance-ids).

### Feedback loops {#feedback-loops}

When the emitting stage's pipeline entry declares `feedback_loop` (see [YAML catalog](yaml-catalog.md#feedback-loops)), a **successful** emit **must** include `feedback_loop`:

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
- `feedback_loop` is **not allowed** on stages that do not declare a feedback-loop policy.
- `send_back` **cannot** be combined with `fork_choice` or `clone_forks` on the same envelope.
- `continue` may still carry `fork_choice` / `clone_forks` when those fields are otherwise required for the stage.
- Nested clone-assignment envelopes must not include `feedback_loop`.

On replay, agents see a **Feedback Loop Context** section (JSON) with loop/replay ids, the source's send-back envelope (summary, artifacts, payload), remaining replays, route stage ids, and optional prior-attempt / active fork-generation hints. Use that context — not scraped transcripts — to address the feedback.

After `max_replays`, behavior follows `on_max_replays` (`require_continue` or `wait_for_human`). Human decisions: [CLI](cli-reference.md#sf-runs-feedback-decide), [MCP `decide_feedback_loop`](mcp.md#decide_feedback_loop), or `POST /api/runs/:runId/stages/:stageId/feedback-decision`.

Walkthrough: [`examples/feedback-loop/`](../examples/feedback-loop/). Fixture: [`feedback-loop.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop.pipeline.yaml).

### io schemas {#io-schemas}

When a stage declares `io.output.schema`, success `payload` is required and checked against a JSON Schema subset (`src/envelope/payloadSchema.ts`). `io.input.schema` is the same subset, used for clone assignment payloads and (when both exist) matching optional task `input` on entry stages. The root must be `type: object` and cannot be `nullable`. Supported node types: `object`, `string`, `number`, `integer`, `boolean`, `array`. Keywords: `properties`, `required`, `items`, `additionalProperties` (boolean only), `minItems`, `enum` (string and integer), `minimum`, `maximum`. String nodes also accept `pattern` (a JavaScript RegExp string, unicode semantics), `minLength`, and `maxLength` (non-negative integers). Nested nodes may set `nullable: true`, compiling to a union of that type with `null`. Unknown keywords are ignored. Pipeline-file `schemas:` is the `$ref` root (`#/schemas/<name>`); see [YAML catalog — Pipeline schemas](yaml-catalog.md#pipeline-schemas).

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

Two join shapes — do not reuse one field for the other:

1. **Keyed generic fan-in** — the stage `needs` array has length ≥ 2. Join input is `priorEnvelopesByStage`, a record keyed in YAML declaration order. A normal parent maps to one terminal envelope; a clonable parent maps to that parent's clone-list-ordered envelope array (or `[]` when a skip of the definition is accepted). `priorEnvelope` is `null`. `priorEnvelopes` is omitted. A failed parent uses its emitted failure envelope or a synthetic `{ status: "failure", summary, artifacts: [] }` from the persisted failure reason. A skipped parent uses a synthetic `{ status: "skipped", summary, artifacts: [] }` rebuilt from persisted lifecycle state — agents cannot emit `skipped`. See [YAML catalog — generic fan-in](yaml-catalog.md#generic-fan-in), [`examples/generic-fan-in/`](../examples/generic-fan-in/), and [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml).

2. **Clone-list join** — still one catalog parent id. After clonable fan-out, the join successor receives every clone envelope as an ordered list in clone-list order (`priorEnvelopes`). The join stage only runs if every clone succeeded (parallel and sequential); those priors are success envelopes only (0.7). See [`examples/clonable-fanout/`](../examples/clonable-fanout/) collect checks.

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

When the detect stage emits `fork_choice: []`, handoff output is `{ "skipped": true }` and downstream deliver/upload steps can no-op.

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
