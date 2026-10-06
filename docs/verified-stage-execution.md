---
layout: default
title: Verified Stage Execution
---

# Verified Stage Execution

Verified Stage Execution makes a stage's success an independently checked outcome,
rather than only an agent claim. It is the first slice of the broader Stageflow Control
Profiles initiative.

The first slice has a deliberately fixed set of check types. New check types are not
added casually: each must have a clear evidence model, safe runtime semantics, and a
use case not covered by the six core types.

## Configuration

`verify` belongs on the stage body (inline entry or the `uses:` file). `on_verify_fail` belongs on the pipeline stage entry. After-phase items are the VSE bar; the same reusable stage can recover differently in another pipeline via wiring.

```yaml
stages:
  - id: plan
    uses: ./stages/plan.yaml
    entry: true
    route:
      - to: implement
  - id: implement
    uses: ./stages/implement.yaml
    on_verify_fail:
      mode: repair
      max_attempts: 3
      retry_safety: idempotent
      include_failed_checks: true
```

The matching reusable stage declares `io`, `verify`, and any gate kinds the contract uses:

```yaml
id: implement
system_prompt: Implement the approved change and report every changed project file.
model: openai/gpt-5.6-sol
gate_kinds: [confirm]
io:
  output:
    schema:
      type: object
      properties:
        changed_files:
          type: array
          items:
            type: string
      required: [changed_files]
verify:
  - id: unit-tests
    type: command
    run: npm test
    timeout_ms: 600000
  - id: implementation-report
    type: artifact
    path: implementation-report.md
    nonempty: true
    when: [after]
  - id: self-review
    type: checklist
    items:
      - Implementation matches the approved plan
      - Unrelated files were not changed
  - id: valid-handoff
    type: payload_schema
  - id: operator-approval
    type: gate
    kind: confirm
  - id: actual-project-changes
    type: checkout_changes
    path_fields: [changed_files]
```

`type: command`, `checklist`, `payload_schema` (the check type), and `checkout_changes` default to `when: [after]`. `type: gate` defaults to `when: [emit]`. `type: artifact` must set `when` explicitly.

## Core check types

| Type | Required fields | Runtime evidence |
| --- | --- | --- |
| `command` | `id`, `run` | Stageflow runs the declared command, requires a successful exit status, and records stdout, stderr, timestamps, and exit code. Optional: `cwd`, `timeout_ms`. After-only. |
| `artifact` | `id`, `when` | Emit: basename on `envelope.artifacts` (no disk I/O). After: Stageflow resolves the relative path inside the stage attempt's artifact directory and verifies that it exists. Optional `nonempty: true` requires content. |
| `checklist` | `id`, `items` | The agent gives a structured attestation that it considered every listed item. This is visible and recorded, but is not independent verification. After-only. |
| `payload_schema` | `id` | After-only re-check of the captured payload against `io.output.schema`. Emit-time payload validation already runs when that schema is present. |
| `gate` | `id`, `kind` | Emit: last `ask_operator` exchange of this kind in this attempt. After: relevant operator interaction over the run so far. The stage must declare the matching `gate_kinds` value. |
| `checkout_changes` | `id` | Stageflow compares checkout state before and after the attempt and requires a real change. Optional `path_fields` reconciles actual changes with required string-array fields in `io.output.schema`. After-only. |

`gate.kind` is one of `free_text`, `confirm`, `multi_question`, or
`artifact_backed`.

After-phase `gate`/`artifact` checks run **after** a candidate envelope has already
been captured (via repair/manual recovery) and ask a looser, retrospective question
("was this ever satisfied over the run so far" / real on-disk evidence). A stage that
instead wants to block a self-approved success emit **within the same attempt, before
capture** should put `when: [emit]` (or omit `when` on `type: gate`) — see
[Envelopes — emit-phase verify](envelopes.md#verify-emit). Emit and after are items on
the same `verify` list.

## Contract rules

- After-phase items must all pass (`mode: all` is implicit).
- Check IDs are non-empty and unique within a stage.
- Checklist items are non-empty and unique. A checklist is an attestation, so pair it
  with independent evidence for consequential work.
- After-phase artifact paths must be relative and remain inside the attempt artifact directory.
- A `type: payload_schema` after-check requires the stage to declare `io.output.schema`.
- A `gate` check requires its kind in the stage's `gate_kinds`.
- Every `checkout_changes.path_fields` entry must be a required array-of-strings
  field in `io.output.schema`.
- `on_verify_fail.mode: repair` requires a positive `max_attempts` and
  `retry_safety: idempotent`. Side-effecting work uses `mode: manual` unless a
  later policy supplies explicit idempotency or compensation semantics.
- `on_verify_fail` requires at least one after-phase `verify` item.

## Runtime semantics

The runtime lifecycle for a successful agent envelope is:

```text
agent proposes success
  -> envelope is structurally valid
  -> emit-phase verify items run in-session (soft reject)
  -> candidate is captured
  -> after-phase verify items run independently
  -> evidence is persisted
  -> the attempt records whether verification passed, failed, or could not run
  -> all after-phase checks pass: stage succeeds
  -> an after-phase check fails: eligible repair or honest failure
```

An agent may perform its own tests or self-review, but those actions are not proof by
themselves. A command, artifact, checkout, or payload check is executed or read by
Stageflow after the agent proposes success. Operator gates are evidence of an operator
decision. Checklists remain useful because they make procedural obligations explicit,
but they are recorded as agent attestations rather than authoritative evidence. LLM
reviews remain outside this first check set.

## Recovery policy

`on_verify_fail` controls what happens when a candidate success fails an after-phase
verify item:

```yaml
on_verify_fail:
  mode: repair
  max_attempts: 3
  retry_safety: idempotent
  include_failed_checks: true
```

For `mode: repair`, Stageflow starts a fresh agent attempt after an after-phase
verification failure while the total number of attempts remains below
`max_attempts`. The repair prompt receives a compact capsule of the failed checks
and evidence when `include_failed_checks` is true. Every repair attempt runs the
same after-phase `verify` items again.

Automatic repair never follows an agent failure, an invalid recovery policy, or a
side-effecting stage. Deployments, publishing, payments, and other externally
visible work must use `mode: manual` until an explicit compensation policy exists.

## Manual recovery

For `on_verify_fail.mode: manual`, a failed after-phase check leaves the stage failed. It
does not silently reuse the normal retry path. The operator sees the attempt history
and must make one explicit decision:

- Retry, with optional instructions for the next agent attempt.
- Stop recovery, leaving the stage failed for this run.

Stageflow records either choice. A manual retry starts a fresh attempt, carries the
previous failed-check capsule, and includes the operator's instructions in the agent
prompt. A stop is terminal for that stage in the current run; use a fresh run to try
again later. The ordinary `retry` action is refused for this failure so it cannot
bypass the manual decision.

```text
sf runs recover --run <runId> --stage <stageId> --guidance "Fix the failing check"
sf runs recover --run <runId> --stage <stageId> --stop
POST /api/runs/<runId>/stages/<stageId>/recovery { "guidance": "…" }
POST /api/runs/<runId>/stages/<stageId>/recovery/stop
MCP: recover_manual_stage / stop_manual_recovery
```

## Visibility

Stageflow keeps verification evidence with the individual attempt that produced it.
Each attempt also records its verification disposition (`not_run`, `passed`, `failed`,
or `error`), so recovery policy is based on a durable fact rather than an error-message
convention:

| Disposition | Meaning |
| --- | --- |
| `not_run` | The agent did not reach after-phase verification. |
| `passed` | Every declared after-phase verify item passed. |
| `failed` | At least one after-phase verify item did not pass. |
| `error` | The verification runtime could not complete its work. |

The operator console shows this history when a stage is open: each attempt lists its
verify checks, their status, and expandable evidence. This makes an automatic
repair legible rather than looking like a single unexplained retry.

The same history is available to automation:

```text
sf runs verify --run <runId> --stage <stageId> --json
GET /api/runs/<runId>/stages/<stageId>/verification
MCP: get_stage_verification
```

The focused stage endpoint is intentional. Command output can be sizable, so normal
run lists and summaries do not include every check's evidence.

## Deliberately deferred check types

The following are useful, but are not part of the Slice 1 contract surface:

- Declarative filesystem or JSON predicates.
- Service/client round-trip checks.
- Effect-manifest reconciliation.
- LLM review.
- Agent-proposed dynamic checks.

They require additional permission, evidence, or retry-safety design. Until then,
model them with the six core types or an explicit human gate.
