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
  stage_id?: string;
  notes?: string;
};
```

| Field | Required | Description |
|-------|----------|-------------|
| `status` | yes | `"success"` advances the pipeline. `"failure"` on a named stage halts scheduling; a parallel clone failure lets sibling clones finish and skips the join and its descendants |
| `summary` | yes | Non-empty human-readable summary |
| `artifacts` | yes | Array of run-relative artifact paths (may be empty `[]`) |
| `payload` | no | Structured data for downstream stages; required on success when the stage declares `payload_schema` |
| `fork_choice` | no* | Non-clonable immediate successor ids to run; required on success when the stage has a `fork` field and at least one non-clonable child |
| `clone_forks` | no* | Clone actions for clonable successors; required on success when any immediate successor is `clonable`; illegal items are rejected by emit |
| `stage_id` | no | Optional stage id echo |
| `notes` | no | Optional free-form notes |

\* Required for fork stages on success (`fork_choice`) and when any immediate successor is clonable (`clone_forks`). On failure, neither field is required or validated. Extra `clone_forks` is ignored only when the emitting stage has no clonable children; if any clonable child exists, `clone_forks` must cover every clonable successor exactly once (extra `successor_id`s are rejected).

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

On `status: "failure"`, the envelope is accepted. A named-stage failure halts scheduling. A parallel clone failure does not stop sibling clones; the join successor and its descendants are skipped. Sequential clone failure skips remaining clones of that successor and the join. Neither `fork_choice` nor `clone_forks` is required or validated on failure.

If the stage declares `payload_schema` in YAML, `payload` is validated against that JSON Schema subset on success — see [payload_schema](#payload-schema).

### Fork stages

If the stage's pipeline entry has a `fork` field and at least one non-clonable child, the success emit **must** include `fork_choice: string[]` naming which of those successors to run. A fork parent whose every child is clonable does not require `fork_choice`. Absent or illegal choices cause the emit to be rejected (`isError: true`); the stage fails when no valid emit follows before the session ends.

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

Unchosen successors are `skipped` — the same status used when a parent fails. See [YAML catalog](yaml-catalog.md#fork-pipelines) for the `fork` field.

### Clonable successors {#clonable-successors}

If any immediate successor is `clonable: true`, the success emit **must** include `clone_forks`. Tokens are `skip` | `once` | `fanout` unless the parent declares `clone_actions` (a non-empty subset). Omit `clone_actions` to keep all three. `once` is not fan-out of 1; `fanout` N is 2 through `clone_cap`. See [YAML catalog](yaml-catalog.md#clonable-successors).

The user prompt and emit tool both name the legal successor ids, clone caps, allowed actions, and each successor's assignment schema. `successor_id` is an enum of those ids. Invented ids, an empty `clone_forks` list, a disallowed action, or an assignment payload that fails `clone_input_schema` stay in-session (`isError`, no `terminate`).

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

Illegal items are rejected by emit. A successor may declare `clone_input_schema` (same JSON Schema subset as `payload_schema`). That schema validates `envelope.payload` — assignment fields belong there, not at the top level of the `clone_forks` item. Parent emit checks `once` and `fanout` assignment payloads against it. Omit the field to skip the assignment-payload check. Never validate clone briefs against the child's output `payload_schema`. `skip` does not need an assignment payload.

Sequential vs parallel join: in **parallel**, sibling clones still finish after a failure, but the join successor and its descendants are skipped unless every clone succeeded. In **sequential**, the first failure skips remaining clones of that successor and the join successor does not run.

`clone_forks` is required for each clonable successor. When the parent also has `fork`, `fork_choice` names only non-clonable siblings. A fork parent whose every child is clonable does not require `fork_choice`. See [`clone-fanout-mix.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-mix.pipeline.yaml) and [`examples/clonable-fanout/`](../examples/clonable-fanout/) scenario F.

A clone may skip / once / fan-out its next stage only when that successor is clonable. Extra `clone_forks` is ignored only when the emitting stage has no clonable children (for example a nested clone whose successor is a non-clonable join). If any clonable child exists, `clone_forks` must list every clonable successor exactly once; extra `successor_id`s are rejected. See [`clonable-nested-gate.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-gate.pipeline.yaml) and [`examples/clonable-fanout/`](../examples/clonable-fanout/). Two clones fanning out the same successor is unsupported in v1 because instance ids are `{catalogId}~{n}`. Dual-parent nested fan-out is fail-closed at apply.

After fan-out, workspace paths and `--stage` keys use the instance id (`{catalogId}~{n}`); run-once keeps the catalog id. See [YAML catalog — instance ids](yaml-catalog.md#clonable-instance-ids).

### payload_schema {#payload-schema}

When a stage declares `payload_schema`, success `payload` is required and checked against a JSON Schema subset (`src/envelope/payloadSchema.ts`). The root must be `type: object`. Supported node types: `object`, `string`, `number`, `integer`, `boolean`, `array`. Keywords: `properties`, `required`, `items`, `additionalProperties` (boolean only), `minItems`, `enum` (string and integer), `minimum`, `maximum`. Unknown keywords are ignored.

Fixture: [`tests/fixtures/stages/name-selection.yaml`](../tests/fixtures/stages/name-selection.yaml).

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

After clonable fan-out, the join successor receives every clone envelope as an ordered list in clone-list order (`priorEnvelopes`). The join stage only runs if every clone succeeded (parallel and sequential); those priors are success envelopes only (0.7). See [`examples/clonable-fanout/`](../examples/clonable-fanout/) collect checks.

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

- [YAML catalog](yaml-catalog.md) — `payload_schema` on stage bodies
- [HITL](hitl.md) — gates before emit
- [CLI reference](cli-reference.md) — `sf envelope get`, handoff format
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — stages that exercise emit + artifacts
