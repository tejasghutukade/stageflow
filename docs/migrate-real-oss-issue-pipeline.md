---
layout: default
title: Migrate the Real OSS Issue Pipeline
---

# Migrate the Real OSS Issue Pipeline to Verified Stage Execution

Use this guide when moving `examples/oss-issue-contribution/` from
`codex/real-oss-issue-pipeline` onto the official Verified Stage Execution
support in PR #23. Its goal is to replace the older, stage-owned deliverable
contract implementation with pipeline-owned `completion` and `recovery`
policy.

The old branch contains useful work beyond deliverable contracts. Preserve that
work separately; do not copy its contract runtime into the new implementation.

## Outcome

After this migration:

- reusable stage files describe the agent task, payload schema, and allowed
  gate kinds;
- the pipeline declares the proof required for each use of a stage;
- Stageflow runs checks after an agent proposes success and retains evidence for
  each attempt;
- automatic and manual recovery use the stored verification disposition;
- the old `required_artifacts`, `require_checkout_diff`,
  `checkout_path_fields`, and emit-time declared-gate completion paths are
  gone.

Read [Verified Stage Execution](verified-stage-execution.md) for the
authoritative check syntax. This document only records the migration decisions
for the OSS example.

## Preconditions

1. Start from `main` with PR #23 merged or applied. Do not begin from a copy of
   the old contract runtime.
2. Inspect the old example without checking out its branch:

   ```bash
   git show codex/real-oss-issue-pipeline:examples/oss-issue-contribution/oss-issue-contribution.pipeline.yaml
   git grep -n -E 'required_artifacts|require_checkout_diff|checkout_path_fields' \
     codex/real-oss-issue-pipeline -- examples/oss-issue-contribution src tests
   ```

3. Keep the old branch available as evidence for prompts, payload schemas,
   clone behavior, and example intent. It is not the source of runtime
   contract code.

## Migration map

| Old branch mechanism | Official replacement | Where it belongs | Notes |
| --- | --- | --- | --- |
| `required_artifacts: [report.md]` | `completion.checks` with `type: artifact` and `path: report.md` | Pipeline entry | The runtime verifies the artifact exists in this attempt, not merely that the agent listed a basename. |
| Non-empty `gate_kinds` implicitly required a completed gate before success | `completion.checks` with `type: gate` and the declared `kind` | Pipeline entry | Keep `gate_kinds` in the reusable stage file; the gate check requires it. Add a check only where this pipeline needs that approval. |
| `require_checkout_diff: true` plus `checkout_path_fields` on a writer | `completion.checks` with `type: checkout_changes` and `path_fields` | Pipeline entry | Direct replacement only when the stage itself must edit the checkout. The named fields must remain required arrays of strings in `payload_schema`. |
| Agent-recorded test command | `completion.checks` with `type: command` | Pipeline entry | Add only a stable, repository-correct command. Do not guess one from the language or package manager. |
| Agent's checklist in prose | `completion.checks` with `type: checklist` | Pipeline entry | Useful acknowledgement, not independent proof. Pair it with an artifact, command, checkout, payload, or gate check for consequential work. |

## Do not make these incorrect substitutions

`checkout_changes` captures the checkout before an attempt and compares it
afterward. The old `require_checkout_diff` only asked whether the checkout was
dirty at success time. They are not equivalent for every old stage.

- **`oss-write-regression-test` and `oss-implement-source-fix`:** add
  `checkout_changes`; these are writer attempts and must produce their own
  checkout changes.
- **`oss-verify-fix`:** do **not** add `checkout_changes`. It is intentionally
  read-only, so a per-attempt checkout check would fail even when the upstream
  change is correct. Retain its verification artifact and add a command check
  only if the exact command is stable and known.
- **`oss-address-review-feedback`:** do **not** add `checkout_changes` without
  a product decision. A no-findings review legitimately leaves `fixed_files`
  empty and makes no checkout change. Slice 1 has no conditional check for
  “require a change only when findings exist.” Keep its payload and prompt
  discipline, then either split the no-op and repair paths or add a later
  conditional-check capability.

## Exact catalog edits

Remove `required_artifacts`, `require_checkout_diff`, and
`checkout_path_fields` from every reusable stage file under
`examples/oss-issue-contribution/`. Put their official equivalents on the
matching entry in `oss-issue-contribution.pipeline.yaml`.

### 1. Add artifact checks for all former required artifacts

Each old `required_artifacts` entry becomes an artifact check on the matching
pipeline stage. Use the table below as the complete checklist.

| Stage | Artifact paths |
| --- | --- |
| `oss-issue-intake` | `issue-intake.md` |
| `oss-explain-issue` | `issue-explainer.html` |
| `oss-reproduce-issue` | `reproduction.md` |
| `oss-plan-investigation` | `investigation-map.md` |
| `oss-investigate-area` | `investigation.md` |
| `oss-approve-plan` | `implementation-plan.md` |
| `oss-write-regression-test` | `regression-test-report.md` |
| `oss-implement-source-fix` | `implementation-report.md` |
| `oss-verify-fix` | `verification.md` |
| `oss-explain-fix` | `fix-explainer.html` |
| `oss-plan-review` | `review-plan.md` |
| `oss-review-change` | `review.md` |
| `oss-address-review-feedback` | `review-feedback-report.md` |
| `oss-approve-contribution` | `contribution-package.md`, `pull-request.md` |

For example, change the pipeline entry for `oss-implement-source-fix` to this
shape. Keep its existing `uses` and `needs` values.

```yaml
- id: oss-implement-source-fix
  uses: ./oss-implement-source-fix.yaml
  needs: oss-write-regression-test
  completion:
    mode: all
    checks:
      - id: implementation-report
        type: artifact
        path: implementation-report.md
      - id: checkout-change
        type: checkout_changes
        path_fields: [changed_files]
  recovery:
    mode: repair
    max_attempts: 3
    retry_safety: idempotent
    include_failed_checks: true
```

Use unique, stage-local check IDs. Add `nonempty: true` only where an empty
file would be an invalid deliverable; the old contract only required a listed
basename, so decide that strengthening deliberately.

### 2. Replace approval enforcement deliberately

Keep this declaration in the two reusable approval stages:

```yaml
gate_kinds: [artifact_backed]
```

Then add the following check to the corresponding pipeline entries:

```yaml
- id: operator-approval
  type: gate
  kind: artifact_backed
```

Do this for:

- `oss-approve-plan`
- `oss-approve-contribution`

Do not add a gate check merely because a stage declares `gate_kinds: []` or
omits `gate_kinds`. The old branch used that field both to constrain tool use
and to create an implicit success rule; the official model keeps the tool
declaration and makes the success rule explicit at the pipeline entry.

### 3. Move only writer proof to `checkout_changes`

Add this check to `oss-write-regression-test`:

```yaml
- id: checkout-change
  type: checkout_changes
  path_fields: [test_files]
```

Add this check to `oss-implement-source-fix`:

```yaml
- id: checkout-change
  type: checkout_changes
  path_fields: [changed_files]
```

The stage file's `payload_schema` must continue to make the matching field a
required array of strings. The check compares the claimed paths against actual
changes made during the attempt, so reports and run artifacts cannot satisfy
the claim.

Do not move the old `oss-verify-fix` or `oss-address-review-feedback` checkout
fields into this check; use the decisions in [Do not make these incorrect
substitutions](#do-not-make-these-incorrect-substitutions).

### 4. Choose recovery per side effect

Use `recovery.mode: repair` only for idempotent, local work where a fresh agent
attempt is safe. The writer stages above are candidates after confirming their
prompts and task constraints make re-execution safe.

Use `recovery.mode: manual` for publishing or other externally visible work.
`oss-approve-contribution` opens a pull request, so it must be manual if it
has a completion contract. The operator can then retry with guidance or stop
the recovery; ordinary retry cannot bypass that decision.

If a stage has no completion contract, omit `recovery`. Recovery policy exists
to respond to completion verification failure, not ordinary agent failure.

### 5. Add command checks only from known evidence

The old OSS prompts ask agents to run task-specific validation commands. Those
commands often come from an approved plan and are not stable pipeline YAML.
Keep that prompt behavior. Add a `command` check only when the exact command,
working directory, and timeout are known in advance—for example a fixed example
smoke test. A command check is an execution policy, not a language detector.

## Remove the superseded runtime surface

After the catalog uses official checks, remove the old contract paths from the
branch rather than supporting both models:

1. Delete `required_artifacts`, `require_checkout_diff`, and
   `checkout_path_fields` from the stage type, loader, allowed-key list, prompt
   hints, emit input, and tests. In the old branch, start with
   `src/types/stage.ts`, `src/config/loadStage.ts`,
   `src/config/pipelineStageKeys.ts`, `src/agent/piAdapter.ts`, and
   `src/tools/emitStageEnvelope.ts`.
2. Remove only the old **automatic** declared-gate-completion call from the
   emit path. Keep the QA-trail capability: the official `gate` completion
   check uses it after the agent proposes success.
3. Delete the old contract-specific tests, especially the required-artifact,
   checkout-contract, and emit-time gate-completion suites. Replace them with
   completion-contract, checkout capability, verified execution, automatic
   repair, and manual recovery tests from PR #23.
4. Remove old documentation that says a successful emit itself proves an
   artifact, gate, or checkout contract. Point example readers to
   `docs/verified-stage-execution.md` instead.

Do not remove `clone_actions`, `clone_input_schema`, `timeout_ms`, payload
schema keyword support, clone retry behavior, or unrelated UI work merely
because they live on the old branch. Verified Stage Execution does not replace
those capabilities; carry them through as independent decisions.

## Validation and completion criteria

The migration is complete only when all of the following are true:

1. `rg -n 'required_artifacts|require_checkout_diff|checkout_path_fields'
   examples/oss-issue-contribution src tests docs` has no old contract runtime
   or catalog use left, apart from this migration guide or historical notes.
2. Every artifact in the table above has exactly one matching pipeline-owned
   artifact check.
3. The two approval stages retain `gate_kinds: [artifact_backed]` and have one
   matching `gate` completion check each.
4. Only the two writer stages use `checkout_changes`; the read-only and
   conditional stages follow the documented exception decisions.
5. A failure of an artifact, gate, command, or checkout check appears in
   `sf runs verify --run <runId> --stage <stageId> --json` with durable
   evidence. A repair or manual recovery creates a new attempt rather than
   overwriting that evidence.
6. Run:

   ```bash
   npm test -- tests/completion.contract.test.ts tests/runtime.verifiedStageExecution.test.ts \
     tests/runtime.automaticRepair.test.ts tests/runtime.manualRecovery.test.ts \
     tests/runstore.verificationHistory.test.ts
   npm run typecheck
   npm run ui:test
   git diff --check
   ```

At that point the OSS pipeline uses the official product surface while retaining
the independent OSS, clone, and task-specific behavior that Verified Stage
Execution was not intended to replace.
