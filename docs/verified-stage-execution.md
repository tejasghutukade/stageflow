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

`completion` and `recovery` belong on a pipeline stage entry. They are execution
policy: the same reusable stage can have a different completion bar in another
pipeline.

```yaml
stages:
  - id: implement
    uses: ./stages/implement.yaml
    needs: plan
    completion:
      mode: all
      checks:
        - id: unit-tests
          type: command
          run: npm test
          timeout_ms: 600000
        - id: implementation-report
          type: artifact
          path: implementation-report.md
          nonempty: true
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
    recovery:
      mode: repair
      max_attempts: 3
      retry_safety: idempotent
      include_failed_checks: true
```

The matching reusable stage declares the handoff data and any gate kinds the contract
uses:

```yaml
id: implement
system_prompt: Implement the approved change and report every changed project file.
model: openai/gpt-5.6-sol
gate_kinds: [confirm]
payload_schema:
  type: object
  properties:
    changed_files:
      type: array
      items:
        type: string
  required: [changed_files]
```

## Core check types

| Type | Required fields | Runtime evidence |
| --- | --- | --- |
| `command` | `id`, `run` | Stageflow runs the declared command, requires a successful exit status, and records stdout, stderr, timestamps, and exit code. Optional: `cwd`, `timeout_ms`. |
| `artifact` | `id`, `path` | Stageflow resolves the relative path inside the stage attempt's artifact directory and verifies that it exists. Optional `nonempty: true` requires content. |
| `checklist` | `id`, `items` | The agent gives a structured attestation that it considered every listed item. This is visible and recorded, but is not independent verification. |
| `payload_schema` | `id` | Stageflow validates the successful envelope payload against the reusable stage's declared `payload_schema`. |
| `gate` | `id`, `kind` | Stageflow verifies the relevant operator interaction in this attempt. The stage must declare the matching `gate_kinds` value. |
| `checkout_changes` | `id` | Stageflow compares checkout state before and after the attempt and requires a real change. Optional `path_fields` reconciles actual changes with required string-array fields in `payload_schema`. |

`gate.kind` is one of `free_text`, `confirm`, `multi_question`, or
`artifact_backed`.

## Contract rules

- `completion.mode` is currently only `all`: every listed check must pass.
- Check IDs are non-empty and unique within a stage.
- Checklist items are non-empty and unique. A checklist is an attestation, so pair it
  with independent evidence for consequential work.
- Artifact paths must be relative and remain inside the attempt artifact directory.
- A `payload_schema` check requires the reusable stage to declare `payload_schema`.
- A `gate` check requires its kind in the reusable stage's `gate_kinds`.
- Every `checkout_changes.path_fields` entry must be a required array-of-strings
  field in the reusable stage's `payload_schema`.
- `recovery.mode: repair` requires a positive `max_attempts` and
  `retry_safety: idempotent`. Side-effecting work uses `mode: manual` unless a
  later policy supplies explicit idempotency or compensation semantics.

## Runtime semantics

The runtime lifecycle for a successful agent envelope is:

```text
agent proposes success
  -> envelope is structurally valid
  -> completion checks run independently
  -> evidence is persisted
  -> the attempt records whether verification passed, failed, or could not run
  -> all checks pass: stage succeeds
  -> a check fails: eligible repair or honest failure
```

An agent may perform its own tests or self-review, but those actions are not proof by
themselves. A command, artifact, checkout, or payload check is executed or read by
Stageflow after the agent proposes success. Operator gates are evidence of an operator
decision. Checklists remain useful because they make procedural obligations explicit,
but they are recorded as agent attestations rather than authoritative evidence. LLM
reviews remain outside this first check set.

## Recovery policy

`recovery` controls what happens when a candidate success fails a completion check:

```yaml
recovery:
  mode: repair
  max_attempts: 3
  retry_safety: idempotent
  include_failed_checks: true
```

For `mode: repair`, Stageflow starts a fresh agent attempt after a completion
verification failure while the total number of attempts remains below
`max_attempts`. The repair prompt receives a compact capsule of the failed checks
and evidence when `include_failed_checks` is true. Every repair attempt runs the
same completion contract again.

Automatic repair never follows an agent failure, an invalid recovery policy, or a
side-effecting stage. Deployments, publishing, payments, and other externally
visible work must use `mode: manual` until an explicit compensation policy exists.

## Manual recovery

For `recovery.mode: manual`, a failed completion check leaves the stage failed. It
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
convention.
The operator console shows this history when a stage is open: each attempt lists its
completion checks, their status, and expandable evidence. This makes an automatic
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
