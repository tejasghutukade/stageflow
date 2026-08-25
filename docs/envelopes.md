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
| `stage_id` | no | Optional stage id echo |
| `notes` | no | Optional free-form notes |

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

## See also

- [YAML catalog](yaml-catalog.md) — `payload_schema` on stages
- [HITL](hitl.md) — gates before emit
- [Quick start](quickstart.md) — end-to-end first run
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — stages that exercise emit + artifacts
