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
2. Reproduce the failure without editing tracked files.
3. Fan out 1–5 read-only investigations in parallel.
4. Join the evidence into an implementation plan and ask for approval.
5. Let one stage write the regression test and minimal fix.
6. Independently verify the diff and relevant tests.
7. Fan out 3–4 focused reviews in parallel.
8. Join the reviews into a PR-ready package and ask for final approval.

The agents never commit, push, or open an upstream pull request. The operator
publishes only after reviewing the working tree and final artifact.

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
  Investigate and prepare a minimal upstream fix for Mastra issue #22863.
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
the absolute path of that clone. The stage definitions do not need to change.

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

Run `sf ui` in another terminal to inspect envelopes, artifacts, clone fan-out,
and answer the two artifact-backed gates.

## Safety and interpretation

- Plan approval authorizes only local edits in the task checkout.
- Review clones always complete successfully and carry `pass` or
  `changes_required` in their payload, allowing the join stage to see every
  review.
- Any blocking review fails the final stage closed.
- The final approval confirms the contribution package; it does not publish it.
- Issue labels, assignments, and maintainer guidance can change. Re-verify them
  before opening an upstream pull request.
