# route wiring smoke test

Seven small, self-contained pipelines that together cover the `route`-based pipeline wiring migration's YAML surface, plus eight deliberately-invalid ones that each trigger one specific rejection error.

- The 7 **valid** ones live directly in this directory and are registered in the repo's `stageflow.yaml` catalog (the directory is listed once; new `*.pipeline.yaml` files dropped in here are picked up automatically), so they show up in `sf ui` / the pipeline picker and are runnable end-to-end with `smoke-test.task.yaml`.
- The 8 **rejected** ones live in `rejected/` and are excluded from the catalog via `stageflow.yaml`'s `exclude:` list — **they will not show up in the UI on purpose**, so they don't clutter the picker or fail a catalog-wide validate/CI run. Each demonstrates one distinct pipeline-level failure; since a whole pipeline fails to load on its first error, these can't usefully be merged into fewer files without hiding all but one message per file. They're CLI-only, via `sf validate --pipeline <path>`.

## Patterns covered — which pipeline for which feature

If you think of this in classic workflow-pattern terms: **AND** = unconditional fan-out/fan-in (every branch always runs, the join waits for all of them) vs. **OR** = `route_select`-driven branching (the stage's own decision picks one or a subset, the rest are skipped). There is no "OR-join" in this system by design — a join with multiple parents always waits for *every* one of them (an unpicked branch still counts once it resolves to `skipped`); that was a deliberate call made during the design of this migration, not a gap.

| Pipeline ID | File | Demonstrates |
|---|---|---|
| `route-demo-core` | `01-core-routing.pipeline.yaml` | The broadest single flow: entry, forward routing, loop (`require_continue`/`resume`), `route_select: one`, `route_select: subset`+`allow_none`, fan-in join. `ship`'s subset pick has come back empty both times run so far, so you won't see a `notify-*` stage actually execute here — that's what #5 is for. |
| `route-demo-on-gate` | `02-on-gating.pipeline.yaml` | `on: [succeeded]` / `on: [failed]` state-gated routing, declared on the source stage. |
| `route-demo-two-entries` | `03-two-entry-points.pipeline.yaml` | Multiple independent `entry: true` roots. |
| `route-demo-entry-false` | `04-entry-false-equivalent-to-omitted.pipeline.yaml` | `entry: false` behaves like omitting the key (code-review fix). |
| `route-demo-fork-choice` | `05-fork-choice.pipeline.yaml` | **OR pattern.** Deterministic prompts so `route_select: one` and `route_select: subset`+`allow_none` reliably make a real, non-trivial pick every run — run this to actually *watch* a branch execute, not just prove the wiring is valid. |
| `route-demo-fan-out-fan-in` | `06-fan-out-fan-in.pipeline.yaml` | **AND pattern.** True parallel fan-out (no `route_select` — all 3 branches always run) into a join that waits for and combines all 3 real outputs. |
| `route-demo-loop-human-decision` | `07-loop-human-decision.pipeline.yaml` | The loop config variants #1 doesn't cover: `on_max_replays: wait_for_human` + `replay_session: new_session`. Reliably parks the run waiting for a human decision — exercises the HITL UI flow (`sf runs answer`), not a bug/stuck state. |

## Important: use the local build, not your global `sf`

Your globally-installed `sf` (`/opt/homebrew/bin/sf`, `stageflow@0.1.0`) is a much older release and does not contain this branch's changes — running the bare `sf` command would test the wrong code entirely. Use one of these instead, from the **repository git root**:

```bash
# no build step, always current — what every command below uses
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml --strict

# or build once, then use the built CLI directly
npm run build
node dist/cli.js validate --pipeline examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml --strict
```

If you want the bare `sf`/`stageflow` command itself to point at this worktree (e.g. so `sf ui` in a browser tab uses it too), run `npm link` from the repo root once — that swaps your global install for this working copy until you `npm unlink` or reinstall the real global package. That's a machine-wide change, so it's your call whether to do it; the commands below don't need it.

`sf validate` never calls a model — it only resolves the pipeline's DAG and runs this project's parsing/validation logic, so every command below is free and instant.

## Valid pipelines (should pass)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml --strict
```
Expect: **Validation passed.** One pipeline, most of the new surface in one realistic flow:
`plan -> implement -> review` (review's `route` mixes a normal forward entry to `qa` with a `type: loop` entry back to `implement`, `max_replays: 2`, `on_max_replays: require_continue`, `replay_session: resume`) `-> qa` (`route_select: one` — picks `ship` or `request-changes`) `-> ship` (`route_select: subset` + `allow_none: true` — picks any of `notify-slack`/`notify-email`/`update-changelog`, or none) `-> close` (fan-in: waits on all four of `request-changes`/`notify-slack`/`notify-email`/`update-changelog`, most of which resolve "skipped" rather than "succeeded" — that still satisfies the implicit-AND join).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/02-on-gating.pipeline.yaml --strict
```
Expect: **Validation passed.** `run-tests` routes to `ship` on `succeeded` and to `hotfix` on `failed` — the `on` gate is declared on the *source* stage now, not the target's old `needs`. (Distinct mechanism from `route_select`/`fork_choice` — state-gated, not envelope-chosen.)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/03-two-entry-points.pipeline.yaml --strict
```
Expect: **Validation passed.** Two independent `entry: true` stages, no wiring between them — a topology the core pipeline can't demonstrate (it only has one root).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/04-entry-false-equivalent-to-omitted.pipeline.yaml --strict
```
Expect: **Validation passed.** `draft` explicitly writes `entry: false`; this must behave exactly like omitting the key. This is the code-review fix that closed a bug where `entry: false` used to incorrectly force the whole pipeline into strict entry-stage validation.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/05-fork-choice.pipeline.yaml --strict
```
Expect: **Validation passed.** The **OR pattern**, made meaningful: `01-core-routing`'s `ship` decision has `allow_none: true` and (both times it's been run so far) the model has chosen nothing, so you never actually see a branch execute. This pipeline's prompts are written to be unambiguous, so the model reliably makes a real, non-trivial pick every run instead: `triage` (`route_select: one`, no `allow_none` — a mandatory pick) always chooses `quick-fix` over `big-project`; `quick-fix` (`route_select: subset` + `allow_none: true`, same shape as `ship`) always chooses `notify-team` + `update-docs` but not `schedule-followup` — a genuine subset, never empty and never everything. `close` fans in across a mix of two stages that actually ran and one that was skipped.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/06-fan-out-fan-in.pipeline.yaml --strict
```
Expect: **Validation passed.** The **AND pattern**: `kickoff` has no `route_select` at all, so its `route` list of three targets (`research`/`analysis`/`review-notes`) all fire unconditionally — true parallel fan-out, no skipping. `synthesize` is the fan-in join: it waits for and combines all three, every run, since none of them are ever optional.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/07-loop-human-decision.pipeline.yaml --strict
```
Expect: **Validation passed.** The loop config variants `01-core-routing` doesn't exercise: `on_max_replays: wait_for_human` (vs. `require_continue`) and `replay_session: new_session` (vs. `resume`). `review`'s prompt always sends work back to `implement`; with `max_replays: 1`, the second send-back exhausts the budget and parks the run for a human decision instead of failing or looping forever.

## Rejected pipelines (should fail with the given message)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/01-reject-legacy-needs.pipeline.yaml --strict
```
Expect: `stage "review": "needs" is no longer supported — declare the wiring on the source stage's "route" instead`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/02-reject-legacy-fork.pipeline.yaml --strict
```
Expect: `stage "decide": "fork" is no longer supported — use "route_select"/"allow_none" alongside "route" instead`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/03-reject-legacy-feedback-loop.pipeline.yaml --strict
```
Expect: `stage "review": "feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/04-reject-missing-entry.pipeline.yaml --strict
```
Expect: `no stage is marked entry: true` — this pipeline uses `route` but nothing is marked as a start.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/05-reject-unreachable.pipeline.yaml --strict
```
Expect: `stage "orphan" is unreachable: not marked entry: true and not targeted by any route entry`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/06-reject-allow-none-without-route-select.pipeline.yaml --strict
```
Expect: `stage "decide": allow_none requires route_select` — the other code-review fix: `allow_none` used to be silently dropped (no error, no effect) when declared without `route_select`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/07-reject-cycle.pipeline.yaml --strict
```
Expect: `dependency cycle detected` — `a` routes to `b`, `b` routes back to `a`, as plain forward entries (not a loop).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/08-reject-loop-non-ancestor.pipeline.yaml --strict
```
Expect: `stage "b": feedback_loop target "c" must be an earlier ancestor` — `b`'s loop entry targets `c`, which is `a`'s other branch (a sibling), not an ancestor of `b`.

## Run from the UI

All 7 valid pipelines and `smoke-test.task.yaml` are registered in the repo-root `stageflow.yaml`. Point the UI at the local build (see "Important" above — either `npm link` first, or run the UI via `npx tsx src/cli.ts ui`):

```bash
npx tsx src/cli.ts ui
```

Start a new run, pick any of the 7 pipeline IDs from the table above, `route-smoke-test` as the task. Requires a Pi-compatible provider connected (`sf providers login` or via the UI's own connect flow) — actually executing a stage calls a real model, unlike `sf validate` above.

- Want to watch `fork_choice` branch to a real, executing stage? Run `route-demo-fork-choice`.
- Want to watch true parallel fan-out/fan-in? Run `route-demo-fan-out-fan-in`.
- Want to practice the human-in-the-loop decision flow? Run `route-demo-loop-human-decision` — it *will* stop and wait for you; that's expected, use `sf runs waiting` to find it and `sf runs answer --run <runId> --stage review --answer '{"action":"continue"}'` (or the UI's own decide control) to unblock it.
- Want the broadest single flow? Run `route-demo-core` — but note its `ship` decision has consistently picked nothing so far, so you won't see a `notify-*` stage execute there.

Or run one directly from the CLI instead of the UI:

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/06-fan-out-fan-in.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```
