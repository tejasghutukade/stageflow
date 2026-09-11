# route wiring smoke test

Five small, self-contained pipelines that together cover most of the `route`-based pipeline wiring migration, plus eight deliberately-invalid ones that each trigger one specific rejection error.

- The 5 **valid** ones live directly in this directory and are registered in the repo's `stageflow.yaml` catalog, so they show up in `sf ui` / the pipeline picker and are runnable end-to-end with `smoke-test.task.yaml`.
- The 8 **rejected** ones live in `rejected/` and are excluded from the catalog via `stageflow.yaml`'s `exclude:` list, so they don't clutter the UI or fail a catalog-wide validate/CI run. Each demonstrates one distinct pipeline-level failure — since a whole pipeline fails to load on its first error, these can't usefully be merged into fewer files without hiding all but one message per file.

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
`plan -> implement -> review` (review's `route` mixes a normal forward entry to `qa` with a `type: loop` entry back to `implement`, `max_replays: 2`) `-> qa` (`route_select: one` — picks `ship` or `request-changes`) `-> ship` (`route_select: subset` + `allow_none: true` — picks any of `notify-slack`/`notify-email`/`update-changelog`, or none) `-> close` (fan-in: waits on all four of `request-changes`/`notify-slack`/`notify-email`/`update-changelog`, most of which resolve "skipped" rather than "succeeded" — that still satisfies the implicit-AND join).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/02-on-gating.pipeline.yaml --strict
```
Expect: **Validation passed.** `run-tests` routes to `ship` on `succeeded` and to `hotfix` on `failed` — the `on` gate is declared on the *source* stage now, not the target's old `needs`. (Distinct mechanism from `route_select`/`fork_choice` above — state-gated, not envelope-chosen.)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/03-two-entry-points.pipeline.yaml --strict
```
Expect: **Validation passed.** Two independent `entry: true` stages, no wiring between them — a topology the core pipeline above can't demonstrate (it only has one root).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/04-entry-false-equivalent-to-omitted.pipeline.yaml --strict
```
Expect: **Validation passed.** `draft` explicitly writes `entry: false`; this must behave exactly like omitting the key. This is the code-review fix that closed a bug where `entry: false` used to incorrectly force the whole pipeline into strict entry-stage validation.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/05-fork-choice.pipeline.yaml --strict
```
Expect: **Validation passed.** A dedicated, *meaningful* fork_choice demo: `01-core-routing`'s `ship` decision has `allow_none: true` and (both times it's been run so far) the model has chosen nothing, so you never actually see a branch execute. This pipeline's prompts are written to be unambiguous, so the model reliably makes a real, non-trivial pick every run instead: `triage` (`route_select: one`, no `allow_none` — a mandatory pick) always chooses `quick-fix` over `big-project`; `quick-fix` (`route_select: subset` + `allow_none: true`, same shape as `ship`) always chooses `notify-team` + `update-docs` but not `schedule-followup` — a genuine subset, never empty and never everything. `close` fans in across a mix of two stages that actually ran and one that was skipped. This is the one to run if you want to *watch* fork_choice branch to real, executing stages rather than proving the wiring is merely valid.

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

The 5 valid pipelines and `smoke-test.task.yaml` are registered in the repo-root `stageflow.yaml` (`examples/route-wiring-smoke-test` is listed once; new `*.pipeline.yaml` files added here are picked up automatically, no further registration needed), so they're picked up by the catalog scan like any other example. Point the UI at the local build (see "Important" above — either `npm link` first, or run the UI via `npx tsx src/cli.ts ui`):

```bash
npx tsx src/cli.ts ui
```

Start a new run, pick `route-demo-core` / `route-demo-on-gate` / `route-demo-two-entries` / `route-demo-entry-false` / `route-demo-fork-choice` as the pipeline, `route-smoke-test` as the task. Requires a Pi-compatible provider connected (`sf providers login` or via the UI's own connect flow) — actually executing a stage calls a real model, unlike `sf validate` above.

`route-demo-fork-choice` is the one to run if you specifically want to watch `fork_choice` branch to real, executing stages — its prompts are written to reliably produce a non-trivial pick every run. `route-demo-core` is the broader one to watch — it's where you'll see the loop's replay decision (at `review`) play out too — but its `ship` decision is allowed to (and, so far, always has) picked nothing, so you won't see a `notify-*` stage actually execute there.

Or run one directly from the CLI instead of the UI:

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```
