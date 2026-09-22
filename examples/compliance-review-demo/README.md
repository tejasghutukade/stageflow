# compliance-review-demo

A demo of Stageflow's human-in-the-loop orchestration. A SOC2-style AWS
check (S3 bucket public-access-block) is the working example — the point is
the *pattern*, not compliance coverage: automated checks that only interrupt
a person when something actually needs their judgment.

## What this demonstrates

- **A gate that skips itself.** `review-verdict.yaml` carries
  `gate_kinds: [confirm]`, but it only calls `ask_operator` when this run's
  verdict differs from the last one recorded for the same check — a
  first-time failure or a repeat result is auto-approved with no human
  involved. A flip (especially FAIL → PASS) pauses for a real yes/no.
- **State that persists across runs.** `store-evidence.yaml` appends to a
  checkout file (`data/evidence-log.json`) instead of a per-attempt
  artifact, so `review-verdict` can compare "this run" against "last run"
  days or weeks apart. `store-evidence.yaml` carries an after-phase `verify`
  check (`type: checkout_changes`, `path_fields: [changed_files]`) so the
  stage can't succeed without a real edit to that file.
- **A reject with nowhere to loop back to.** If the operator rejects a
  flip, `review-verdict` emits a failure instead of re-asking — there's no
  address-feedback stage, because the "fix" happens in AWS itself, outside
  the pipeline, not in another LLM stage.

Full design writeup (why this exists instead of just running Prowler in a
GitHub Action, or self-hosting an existing open-source tool like Comp AI):
see the project conversation this came from.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`)
- A configured provider (`sf providers status`; at least one row
  `configured`)
- No AWS account needed — without AWS credentials on PATH, `poll-bucket-config`
  simulates the check instead, clearly labeled as simulated.

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/compliance-review-demo/compliance-review-demo.pipeline.yaml --strict
```

To run it, use the `stageflow-run` job to build a task with a payload like
`{ "bucket": "customer-uploads", "scenario": "fail" }`, run it once, then
run it again with `"scenario": "fixed"` — the second run is the one that
should pause for review.

Use `sf ui` to watch a run and answer the `review-verdict` gate when it
pauses.
