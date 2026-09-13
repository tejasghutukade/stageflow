# Ship-feature pipeline

A small, general-purpose "ship any small feature through a governed
pipeline" pattern: plan → implement → parallel review → address feedback →
ship. It is deliberately a trimmed sibling of
[`examples/oss-issue-contribution/`](../oss-issue-contribution/) — no intake,
no explainers, no read-only reproduction stage, no investigation fan-out —
built for the common case where a feature is already well understood and the
value is in a governed, evidence-backed path from plan to pull request, not
in a multi-stage investigation.

The pipeline is repository-neutral. Point the task's `checkout` at a
dedicated branch of whatever repository you're shipping into. It reads that
repository's own scripts and conventions before acting; nothing in the stage
files names a specific repository, feature, or keyword.
[`ship-feature.task.yaml`](ship-feature.task.yaml) is one concrete instance
of the pattern — extending Stageflow's envelope JSON Schema subset — not a
template you must follow.

## Flow

1. Plan and get explicit operator approval for the exact scope, edit sites,
   and validation commands (`feat-plan`, one merged propose-and-approve
   stage — there is no separate earlier planning stage).
2. Implement the approved plan and drive its full validation command list to
   green in one session, writing any tests the plan calls for as part of
   implementing rather than in a separate stage (`feat-implement`, the only
   stage with edit access to the checkout).
3. Fan out two to four focused, non-overlapping reviews in parallel — no
   human gate here, this is the one automated fan-out in the middle
4. Address every blocking review finding in one fixup stage — sweeping for
   every instance of the same category of problem, not only the ones
   reviewers happened to cite. This catalog stays a DAG; it does not
   declare `{ type: loop }` back to `feat-implement` or a second review pass
   (`feat-address-feedback`).
5. Assemble a ship package, ask for final approval, and — once the operator
   accepts — push the current branch and open the pull request in that same
   stage (`feat-ship`).

No stage before the last one commits, pushes, or opens a pull request, and
no stage ever creates or renames a branch — the checkout is expected to
already be on the correct feature branch when the run starts. `feat-ship`
writes `ship-package.md`, calls `ask_operator`, and only runs `git`/`gh`
against the checkout's current branch after an explicit accept through its
`artifact_backed` gate. There is no separate publish flag or dry-run mode:
the operator's accept is the only gate between "package written" and "PR
opened."

## Runtime contracts

Every stage declares `io.output.schema`, so a success emit is rejected unless
the payload matches it, and each stage file lists `verify` items so success
is independently checked rather than only claimed. Artifact paths below are
after-phase `type: artifact` checks on the stage body:

| Stage | `gate_kinds` | Required artifacts | Other `verify` |
|-------|--------------|--------------------|----------------|
| `feat-plan` | `[artifact_backed]` | `implementation-plan.md` | `gate` `artifact_backed` |
| `feat-implement` | `[]` | `implementation-report.md` | `checkout_changes` on `changed_files` |
| `feat-review` | `[]` | `review.md` | — |
| `feat-address-feedback` | `[]` | `review-feedback-report.md` | — |
| `feat-ship` | `[artifact_backed]` | `ship-package.md`, `pull-request.md` | `gate` `artifact_backed` |

`feat-implement`'s `checkout_changes` check (with `path_fields: [changed_files]`)
compares the checkout before and after the attempt and rejects a success emit
if `changed_files` is non-empty but the checkout never actually changed, or if
any listed path is not a real checkout-relative change. `feat-plan` and
`feat-ship` each also carry a `gate` verify item of kind `artifact_backed`, so
their `ask_operator` approval is independently verified, not just
self-reported. See [Verified Stage Execution](../../docs/verified-stage-execution.md)
and [YAML catalog — Verify](../../docs/yaml-catalog.md#verify).

it must partition the diff into two to four independent review assignments
and fan them out; it cannot skip review or hand it to a single clone.
`feat-review` `io.input` is an empty object so it stays a subset of
`feat-implement` `io.output`. See

Every stage but `feat-ship` uses `on_verify_fail: { mode: repair, max_attempts: 3,
retry_safety: idempotent, include_failed_checks: true }` on the pipeline
entry, so an after-phase verify failure starts a fresh attempt with the
failed-check evidence carried forward, up to three attempts. `feat-ship` uses
`on_verify_fail: { mode: manual, retry_safety: side_effecting }` instead,
because it publishes: a failed after-phase check there leaves the stage failed
until an operator explicitly retries or stops via `on_verify_fail` manual
handling. See
[Verified Stage Execution — Recovery policy](../../docs/verified-stage-execution.md#recovery-policy).

### Review feedback has no loop in this catalog

Loops exist via `{ type: loop }` on `route` (see
[`examples/feedback-loop/`](../feedback-loop/)). This pipeline does not use
one. If `feat-review` finds a blocking problem, the run does not resume
`feat-implement`. `feat-address-feedback` is the accommodation: a single
fixup stage after review and before shipping that addresses every blocking
finding — sweeping for other instances of the same category of problem, not
only the ones a reviewer happened to cite — then hands off to `feat-ship`,
which independently re-checks the fix before accepting it. It cannot get a
fresh review of its own fix, though: if its patch introduces something new,
`feat-ship`'s fail-closed check is the backstop, and the operator has to
intervene by hand — see [`sf runs retry`](../../docs/cli-reference.md), which
can retry a succeeded stage in place and reset everything downstream.

## Prepare a worktree

This pipeline expects to run against a checkout that is **already** on a
dedicated feature branch — no stage creates, renames, or switches a branch.
A `git worktree` keeps that branch isolated from whatever else you have
checked out in your primary clone of the target repository:

```bash
cd /path/to/your/repo
git fetch origin
git worktree add ../your-repo-feature-branch -b your-feature-branch origin/main
cd ../your-repo-feature-branch
npm install   # or the target repository's equivalent bootstrap command
git status --short
```

Point the task's `checkout` field at that worktree's absolute path. When the
run finishes (or if it fails partway through), remove the worktree with
`git worktree remove ../your-repo-feature-branch` from the main clone once
you no longer need it.

## Create a task

Task context is the pipeline's portable feature brief. Include enough detail
that `feat-plan` can ground a real plan in the actual repository rather than
re-deriving requirements from a one-line goal:

```yaml
id: my-feature
goal: >
  Describe the concrete, scoped change to ship, ending in an
  operator-approved pull request against <owner>/<repo>.
context: |
  Name the exact files and symbols involved, the existing conventions to
  follow (test style, doc sections to update), and the ship target: which
  repository, which base branch, and which branch the checkout is already on.
constraints: |
  Do not create, rename, or switch branches — the checkout is already on the
  correct branch.
  Do not commit, push, or open a pull request in any stage except feat-ship.
checkout: /absolute/path/to/your-repo-feature-branch
```

[`ship-feature.task.yaml`](ship-feature.task.yaml) is a complete example: it
targets this same Stageflow repository, adding `pattern`, `minLength`,
`maxLength`, and `nullable` support to `src/envelope/payloadSchema.ts`
against a worktree on branch `demo/richer-payload-schema-constraints`.

## Run

From any directory with Stageflow installed:

```bash
sf validate \
  --pipeline /path/to/stageflow/examples/ship-feature/ship-feature.pipeline.yaml \
  --strict

sf run \
  --pipeline /path/to/stageflow/examples/ship-feature/ship-feature.pipeline.yaml \
  --task /path/to/my-feature.task.yaml
```

`feat-ship` pushes the checkout's current branch and opens the pull request
as soon as the operator accepts its `artifact_backed` gate — there is no
dry-run mode and no extra flag. `gh` must be on `PATH` and authenticated
(`GH_TOKEN` or `GITHUB_TOKEN`) before you accept, or the publish step will
fail after approval.

Run `sf ui` in another terminal to inspect envelopes, artifacts, clone
fan-out, and answer the two artifact-backed gates.

## Safety and interpretation

- Plan approval authorizes only local edits in the task checkout.
- Review clones always complete successfully and carry `pass` or
  `changes_required` in their payload, so `feat-address-feedback` sees every
  review even when some pass and some don't.
- Any blocking review that survives `feat-address-feedback` fails the final
  stage closed — `feat-ship` cross-checks `addressed_all_blocking` against
  the original `blocking_findings` rather than trusting the fixup stage's
  own claim.
- The operator's accept through `feat-ship`'s `artifact_backed` gate is the
  only authorization to publish, and it happens moments before the stage
  runs `git push` / `gh pr create` in the same session — there is no
  separate flag and no second chance to reconsider after accepting.
- No stage creates, renames, or switches a branch. If the checkout is not
  already on the intended feature branch when the run starts, fix that
  before running — the pipeline will not do it for you.
