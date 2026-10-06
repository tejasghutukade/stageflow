# Verify tour

One short spine that walks every **verify check type** in a single successful run. Each stage does one type. Prompts spell the tool calls so the checks we claim actually pass.

This catalog is a **deep spine**: ungated `to:` is the next stop. Open the stage in the operator console and inspect that attempt’s verify evidence.

Illegal catalogs (emit-only `command`, artifact without `when`, `if` on a loop, …) cannot live here — validate would reject the whole pipeline.

## Run

From the repo git root, after `sf ui` is up, pick pipeline `verify-tour` and task `verify-tour`.

The task binds `checkout: .` (this git tree, resolved from the factory cwd). `checkout-check` writes `verify-tour-marker.txt` at that checkout root. Delete the file when you are done; do not commit it.

Or:

```bash
npx tsx src/cli.ts validate --pipeline examples/verify-tour/verify-tour.pipeline.yaml
npx tsx src/cli.ts run \
  --pipeline examples/verify-tour/verify-tour.pipeline.yaml \
  --task examples/verify-tour/verify-tour.task.yaml
```

Validate should succeed (`ok: true`). You may see `pipeline.model_applies` because `model` is set on the pipeline, not on each stage.

The run should **succeed**. Every stage should **succeed**. `gate-check` pauses for a **confirm** accept in the operator console (or `--skip-gates` on the CLI).

## Walk (follow-along order)

| Level | Stage | Verify type | What the agent does | What Stageflow checks |
|-------|-------|-------------|---------------------|------------------------|
| 1 | `kickoff` | none | Emit empty success | — |
| 2 | `artifact-check` | `artifact` emit + after | `write_stage_artifact` `note.md`, list it on emit | Basename on `artifacts`; file exists nonempty under the attempt artifacts dir |
| 3 | `command-check` | `command` after | Emit empty success | Stageflow runs `echo verify-tour-ok` (exit 0) |
| 4 | `checklist-check` | `checklist` after | Emit `checklist_attestations` for `self-review` | Items match the declared list exactly |
| 5 | `payload-check` | `payload_schema` after | Emit `{"ok": true}` | Re-check captured payload against `io.output.schema` |
| 6 | `gate-check` | `gate` confirm emit + after | `ask_operator` confirm, then emit | Last confirm this attempt is accept |
| 7 | `checkout-check` | `checkout_changes` after | Write `verify-tour-marker.txt` in the checkout | Diff vs pre-attempt snapshot; `changed_files` matches exactly |

## Scenario table

| Scenario | How this pipeline covers it | Evidence |
|----------|------------------------------|----------|
| `type: artifact` emit | `note-declared` `when: [emit]` | Emit lists `note.md` (basename / suffix match, no disk I/O) |
| `type: artifact` after | `note-on-disk` `when: [after]` `nonempty: true` | File on disk under attempt artifacts |
| `type: command` | `echo-ok` `run: echo verify-tour-ok` | After-phase exit 0; stdout in verify evidence |
| `type: checklist` | `self-review` two items | Envelope `checklist_attestations` match |
| `type: payload_schema` | `payload-ok` after `{"ok": true}` | After-phase re-check of `io.output.schema` |
| `type: gate` emit | `operator-ok` `kind: confirm` `when` includes `emit` | Soft reject until confirm accept |
| `type: gate` after | same check `when` includes `after` | After-phase sees the accepted confirm on this attempt |
| `type: checkout_changes` | `repo-touched` `path_fields: [changed_files]` | Marker file appears in the attempt diff and payload |
| Bound checkout required | task `checkout: .` | Without a git checkout this last stage errors |
| No `on_verify_fail` | omitted | A failed after-check fails the stage (no silent repair) |

## Expected stage status

| Stage | Status | Why |
|-------|--------|-----|
| `kickoff` | succeeded | entry |
| `artifact-check` | succeeded | both artifact checks passed |
| `command-check` | succeeded | command exited 0 |
| `checklist-check` | succeeded | attestation matched |
| `payload-check` | succeeded | payload matched schema |
| `gate-check` | succeeded | confirm accepted |
| `checkout-check` | succeeded | marker file changed the checkout |

## Not in this pipeline

These are real cases, but putting them here would fail validate or fail the run.

| Scenario | Why it is absent | Where to see it |
|---------|------------------|-----------------|
| Failing after-phase verify | would fail the stage / run | [Verified Stage Execution](../../docs/verified-stage-execution.md) |
| `on_verify_fail.mode: repair` | recovery policy, not a check type | `tests/fixtures/target-dialect/demo.pipeline.yaml` |
| `on_verify_fail.mode: manual` | needs an operator recover decision after a failed check | [Verified Stage Execution — Manual recovery](../../docs/verified-stage-execution.md#manual-recovery) |
| Other gate kinds (`free_text`, `multi_question`, `artifact_backed`) | `type: gate` is covered; kinds are HITL widgets | `examples/plan-review/`, `tests/fixtures/stages/hitl-four-kinds.yaml` |
| `command` / `checklist` / `payload_schema` / `checkout_changes` with `when: [emit]` | illegal | yaml-catalog Verify |
| Artifact without `when` | illegal | yaml-catalog Verify |
| Gitignored marker file | `--exclude-standard` hides it; the check would fail | git checkout capability |
| Unbound checkout | `checkout_changes` errors without `task.checkout` | [Verified Stage Execution](../../docs/verified-stage-execution.md) |
