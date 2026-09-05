# OSS issue contribution pipeline

Use a real upstream issue to demonstrate Stageflow's strongest runtime features:
evidence-preserving stages, parallel investigation, explicit handoffs, human
approval, one controlled writer, independent verification, parallel review, and
a final publication gate.

The pipeline is repository-neutral. Point the task's `checkout` at a dedicated,
clean branch in Mastra, Pydantic AI, or another project. It reads that project's
own contribution instructions before acting.

## Flow

1. Capture the issue, repository baseline, and contribution rules.
2. In parallel with reproduction, write a ce-explain HTML teaching artifact for the issue (no HITL).
3. Reproduce the failure without editing tracked files.
4. Fan out 1–5 read-only investigations in parallel.
5. Join the evidence into an implementation plan and ask for approval.
6. Write the regression test in its own short stage, then implement the fix
   and drive the plan's full validation command list to green in one
   session — the only stage that can edit the checkout owns the whole
   fix-and-validate loop, rather than handing an unfinished fix to a
   read-only stage that could only report the gap.
7. Independently verify the diff and relevant tests.
8. In parallel with review planning, write a ce-explain HTML teaching artifact for the verified fix (no HITL).
9. Fan out 3–4 focused reviews in parallel.
10. Address every blocking review finding in one fixup stage — sweeping for
    every instance of the same category of problem, not only the ones
    reviewers happened to cite — since the pipeline is a DAG and cannot loop
    back to oss-implement-source-fix or send the fix through a second review
    pass.
11. Join into a PR-ready package, ask for final approval, and — once the
    operator accepts — push the branch and open the pull request against the
    fork in that same stage.

No stage ever targets the upstream repo, and no stage before the final one
commits, pushes, or opens a pull request. `oss-approve-contribution` writes
`contribution-package.md`, calls `ask_operator`, and only runs `git`/`gh`
against the fork after an explicit accept through its `artifact_backed` gate.
There is no separate publish flag or dry-run mode: the operator's accept is
the only gate between "package written" and "PR opened."

## Runtime contracts

Several stages opt into Stageflow runtime contracts that make the pipeline fail
closed when a stage skips its deliverable.

The two writer stages (`oss-write-regression-test`, `oss-implement-source-fix`)
and both explainers (`oss-explain-issue`, `oss-explain-fix`) declare
`gate_kinds: []`, which unregisters the `ask_operator` tool entirely. They
cannot pause for operator input or offer to substitute a report for real
work.

`oss-issue-intake`, `oss-reproduce-issue`, `oss-verify-fix`, and
`oss-address-review-feedback` also declare `gate_kinds: []`; every stage that
produces evidence or a mechanical fixup rather than a decision runs without
`ask_operator`.

### Review feedback has no way back upstream

Stageflow pipelines are DAGs — there is no supported way for a stage to loop
back to an earlier one yet. If `oss-review-change` finds a blocking problem,
the pipeline cannot resume `oss-implement-source-fix` or `oss-verify-fix`
automatically. `oss-address-review-feedback` is the accommodation for that: a
single fixup stage, positioned after review and before approval, that
addresses every blocking finding — sweeping for other instances of the same
category of problem, not only the ones a reviewer happened to cite — then
hands off to `oss-approve-contribution`, which independently re-checks the
fix before accepting it. It cannot get a fresh review of its own fix, though:
if its patch introduces something new, `oss-approve-contribution`'s
fail-closed check is the backstop, and the operator has to intervene by hand —
see [docs/cli-reference.md](../../docs/cli-reference.md) for `sf runs retry`,
which can retry a succeeded stage in place and reset everything downstream.
Automatic loop-back is future work, not something this example papers over.

Every stage declares `required_artifacts`, so a success emit is rejected unless
the named file appears in the envelope's artifact list:

| Stage | `gate_kinds` | `required_artifacts` | `clone_actions` | `require_checkout_diff` | `checkout_path_fields` |
|-------|--------------|----------------------|-----------------|-------------------------|------------------------|
| `oss-issue-intake` | `[]` | `issue-intake.md` | — | — | — |
| `oss-explain-issue` | `[]` | `issue-explainer.html` | — | — | — |
| `oss-reproduce-issue` | `[]` | `reproduction.md` | — | — | — |
| `oss-plan-investigation` | default | `investigation-map.md` | `[once, fanout]` | — | — |
| `oss-investigate-area` | default | `investigation.md` | — | — | — |
| `oss-approve-plan` | `[artifact_backed]` | `implementation-plan.md` | — | — | — |
| `oss-write-regression-test` | `[]` | `regression-test-report.md` | — | `true` | `[test_files]` |
| `oss-implement-source-fix` | `[]` | `implementation-report.md` | — | `true` | `[changed_files]` |
| `oss-verify-fix` | `[]` | `verification.md` | — | `true` | `[changed_files]` |
| `oss-explain-fix` | `[]` | `fix-explainer.html` | — | — | — |
| `oss-plan-review` | default | `review-plan.md` | `[fanout]` | — | — |
| `oss-review-change` | default | `review.md` | — | — | — |
| `oss-address-review-feedback` | `[]` | `review-feedback-report.md` | — | — | — |
| `oss-approve-contribution` | `[artifact_backed]` | `contribution-package.md`, `pull-request.md` | — | — | — |

The two planner stages restrict `clone_actions` so they cannot select `skip`.
`oss-plan-investigation` allows `once` or `fanout`; `oss-plan-review` allows
`fanout` only. Clones are the point of the example; skipping them defeats the
pipeline.

Clone successors `oss-investigate-area` and `oss-review-change` declare
`clone_input_schema` so the planner's fanout assignment payloads are validated
at emit against a required shape (`area_id`/`objective`/`paths`/`questions`/
`constraints` or the review equivalent).

Plan approval (`oss-approve-plan`) and contribution approval
(`oss-approve-contribution`) use `artifact_backed` HITL and cannot self-approve;
the runtime checks the QA trail before accepting a success emit.

`oss-write-regression-test`, `oss-implement-source-fix`, and `oss-verify-fix`
all require an array field (`test_files` or `changed_files`) with
`minItems: 1`. That constraint only checks the array is non-empty — it does
not verify the entries are real edits in the checkout, and a Stageflow
artifact path satisfies it. A run that never touched the checkout has passed
this way before.

All three stages therefore also declare `require_checkout_diff: true` and a
`checkout_path_fields` entry naming that array field, so the runtime enforces
at emit what the prompts alone could not:

- `require_checkout_diff: true` rejects a success emit when
  `git status --porcelain` in the bound task checkout is empty.
- `checkout_path_fields: [changed_files]` rejects a success emit when any
  `changed_files` entry is not a path inside the checkout — including the
  `stages/<id>/attempts/<n>/artifacts/...` paths returned by
  `write_stage_artifact`.

Stageflow is a configurable-stage runtime. These contracts are opt-in per
catalog; this example is one consumer that uses them to enforce a strict
contribution workflow.

## Explainers

The two explainer stages are dead-end siblings: they do not pause investigation,
implementation, or review, and they do not call `ask_operator`. Each composes a
ce-explain HTML teaching artifact — concept for the issue, diff for the verified
fix — grounded in quoted checkout source and an inline SVG, written with
`write_stage_artifact`. Open `issue-explainer.html` and `fix-explainer.html`
from the run artifacts when you want them. They require the `ce-explain` skill
at `.pi/skills/ce-explain/` (copy the skill tree from Compound Engineering;
`sf skills install` expects a doctor binary this skill does not ship).

## Prepare the target repository

Use a dedicated branch and begin with a clean tracked worktree:

```bash
git clone https://github.com/mastra-ai/mastra.git
cd mastra
git switch -c investigate-22863
git status --short
```

## Create a task outside the target checkout

Task context is the pipeline's portable issue input. Include the issue body or
acceptance criteria so the run remains useful if GitHub access is unavailable.

```yaml
id: mastra-22863
goal: >
  Deliver a verified minimal fix for Mastra issue #22863, applied as source and
  test edits in the checkout working tree.
context: |
  Issue: https://github.com/mastra-ai/mastra/issues/22863
  Title: <copy the current issue title>
  Reported behavior: <copy or summarize the concrete failure>
  Expected behavior: <copy or summarize the acceptance criterion>
  Current triage/maintainer status: <record what you verified today>
constraints: |
  Respect all repository contribution and agent instructions.
  Do not publish while the issue is awaiting maintainer direction.
  Do not commit, push, or open a pull request.
  Keep the change limited to the reproduced issue and its regression test.
checkout: /absolute/path/to/mastra
```

For Pydantic AI, use the same shape with a Pydantic issue and set `checkout` to
the absolute path of that clone. A ready task for issue #7971 is
`pydantic-ai-7971.task.yaml`. The stage definitions do not need to change.

## Run

From any directory with Stageflow installed:

```bash
sf validate \
  --pipeline /path/to/stageflow/examples/oss-issue-contribution/oss-issue-contribution.pipeline.yaml \
  --strict

sf run \
  --pipeline /path/to/stageflow/examples/oss-issue-contribution/oss-issue-contribution.pipeline.yaml \
  --task /path/to/mastra-22863.task.yaml
```

`oss-approve-contribution` pushes and opens the pull request against the fork
as soon as the operator accepts its `artifact_backed` gate — there is no
dry-run mode and no extra flag. `gh` must be on `PATH` and authenticated
(`GH_TOKEN` or `GITHUB_TOKEN`) before you accept, or the publish step will
fail after approval.

Run `sf ui` in another terminal to inspect envelopes, artifacts, clone fan-out,
and answer the two artifact-backed gates. The explainer HTML files are ordinary
stage artifacts; they do not appear as gates.

## Safety and interpretation

- Plan approval authorizes only local edits in the task checkout.
- Review clones always complete successfully and carry `pass` or
  `changes_required` in their payload, allowing the join stage to see every
  review.
- Any blocking review fails the final stage closed.
- The operator's accept through `oss-approve-contribution`'s `artifact_backed`
  gate is the only authorization to publish, and it happens moments before the
  stage runs `git push` / `gh pr create` in the same session — there is no
  separate flag and no second chance to reconsider after accepting. It never
  authorizes targeting upstream.
- Issue labels, assignments, and maintainer guidance can change. Re-verify them
  before accepting the gate on a run that will open a pull request.
