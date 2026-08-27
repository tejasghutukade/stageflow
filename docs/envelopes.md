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
  stage_id?: string;
  notes?: string;
};
```

| Field | Required | Description |
|-------|----------|-------------|
| `status` | yes | `"success"` advances the pipeline; `"failure"` stops it |
| `summary` | yes | Non-empty human-readable summary |
| `artifacts` | yes | Array of run-relative artifact paths (may be empty `[]`) |
| `payload` | no | Structured data for downstream stages |
| `fork_choice` | no* | Named immediate successor ids to run; required on success when the stage has a `fork` field |
| `stage_id` | no | Optional stage id echo |
| `notes` | no | Optional free-form notes |

\* Required for fork stages on success. On non-fork stages the field is optional and ignored for routing.

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

On `status: "failure"`, the envelope is accepted but the **pipeline stops** — the stage does not advance successors.

If the stage declares `payload_schema` in YAML, `payload` is validated against that JSON Schema subset on success.

### Fork stages

If the stage's pipeline entry has a `fork` field, the success emit **must** include `fork_choice: string[]` naming which immediate successors to run. Absent or illegal choices cause the emit to be rejected (`isError: true`); the stage fails when no valid emit follows before the session ends.

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
- `fork_choice: []` is accepted only when `allow_none: true` is set in the pipeline `fork` field.
- `fork_choice` on a failure emit is ignored; no successor is named.

Unchosen successors are `skipped` — the same status used when a parent fails. See [YAML catalog](yaml-catalog.md#fork-pipelines) for the `fork` field.

## Artifacts

Use **`write_stage_artifact`** to create files under the stage attempt directory:

```
stages/<stageId>/attempts/<n>/artifacts/<your-file>
```

The tool returns a **run-relative path** to include in `emit_stage_envelope.artifacts`.

Example paths referenced in fixtures:

- `stages/plan-review/attempts/1/artifacts/plan.md`
- `stages/hitl-four-kinds/attempts/1/artifacts/summary.md`

Artifact-backed HITL gates reference these paths in `ask_operator` — see [HITL](hitl.md).

## Storage

Accepted envelopes are written to the run workspace as `envelope.json` under the stage attempt. The SQLite run store also persists envelope JSON for console and MCP queries.

## Rules

1. **One advancing emit per stage attempt** — later emits are ignored after the first acceptance
2. **`artifacts` is required** — pass `[]` when there are no files
3. **`summary` must be non-empty**
4. **`ask_operator` does not complete the stage** — call `emit_stage_envelope` after gates are resolved

## Downstream consumption

Later stages receive prior envelope context through the stage bootstrap (task + upstream summaries/payloads). Exact prompt assembly is handled by the runtime; authors focus on meaningful `payload` and `summary` content.

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

- [YAML catalog](yaml-catalog.md) — `payload_schema` on stages
- [HITL](hitl.md) — gates before emit
- [CLI reference](cli-reference.md) — `sf envelope get`, handoff format
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — stages that exercise emit + artifacts
