# route wiring smoke test

Seventeen small, self-contained pipelines that together cover the `route`-based pipeline wiring YAML surface, plus twenty-nine deliberately-invalid ones that each trigger one specific rejection error.

- The 17 **valid** ones live directly in this directory and are registered in the repo's `stageflow.yaml` catalog (the directory is listed once; new `*.pipeline.yaml` files dropped in here are picked up automatically), so they show up in `sf ui` / the pipeline picker and are runnable end-to-end with `smoke-test.task.yaml`.
- The 29 **rejected** ones live in `rejected/` and are excluded from the catalog via `stageflow.yaml`'s `exclude:` list — **they will not show up in the UI on purpose**, so they don't clutter the picker or fail a catalog-wide validate/CI run. Each demonstrates one distinct pipeline-level failure; since a whole pipeline fails to load on its first error, these can't usefully be merged into fewer files without hiding all but one message per file. They're CLI-only, via `sf validate --pipeline <path>`.

## Patterns covered — which pipeline for which feature

`route` is declarative wiring. Listed forward `to:` stay on the DAG. After a **succeeded** source, each forward entry is eligible (an entry without `if` fires; `if` match fires; `if` miss **skips** that target — the run can still succeed). Single-parent launch still requires succeeded. `on:` is skip-cascade policy, not launch-from-failed. `if` may be a leaf (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`) or nested `all` / `any` / `not`. There is no agent `fork_choice` for catalog pipelines, and `route_select` / `allow_none` are rejected.

A Join (two or more parents name the same child) waits for *every* parent to become terminal. A false inbound `if` (leaf or `all` / `any` / `not` composition) does **not** skip the child while another parent is still running. After every parent **succeeded**, the child runs only if every inbound edge fired (`if` true, or no `if`); it then opens with every parent's success envelope. If any inbound `if` missed, the child is **skipped** — not pending forever, not opened with a partial envelope set. A failed parent still blocks. Pipelines with **no** forward `if` keep today's Join: skipped sibling + succeeded sibling can still run; all-skipped still force-skip. Mixed skip + a succeeded arm’s `if` miss still runs — the all-fired check is only when every parent succeeded.

State-gated routing uses `on:` on the source stage (`succeeded` / `failed`) as skip-cascade policy.

| Pipeline ID | File | Demonstrates |
|---|---|---|
| `route-demo-core` | `01-core-routing.pipeline.yaml` | The broadest single flow: entry, forward routing, loop (`require_continue`/`resume`), unconditional fan-out from `qa` and `ship`, fan-in join. After qa succeeds, both `ship` and `request-changes` run. After ship succeeds, all three notify stages run. `close` fans in those four parents. |
| `route-demo-on-gate` | `02-on-gating.pipeline.yaml` | `on: [succeeded]` / `on: [failed]` state-gated routing, declared on the source stage. |
| `route-demo-two-entries` | `03-two-entry-points.pipeline.yaml` | Multiple independent `entry: true` roots. |
| `route-demo-entry-false` | `04-entry-false-equivalent-to-omitted.pipeline.yaml` | `entry: false` behaves like omitting the key (code-review fix). |
| `route-demo-fork-choice` | `05-fork-choice.pipeline.yaml` | Larger unconditional fan-out: `triage` lists two follow-ups; `quick-fix` lists three. All listed `to:` targets run. Overlaps `06` on purpose — a bigger fan-out graph in one file. |
| `route-demo-fan-out-fan-in` | `06-fan-out-fan-in.pipeline.yaml` | Parallel fan-out (all 3 branches always run) into a join that waits for and combines all 3 real outputs. |
| `route-demo-loop-human-decision` | `07-loop-human-decision.pipeline.yaml` | The loop config variants `01` doesn't cover: `on_max_replays: wait_for_human` + `replay_session: new_session`. Reliably parks the run waiting for a human decision — exercises the HITL UI flow (`npx tsx src/cli.ts runs answer`), not a bug/stuck state. |
| `route-demo-skip-and-multi-on` | `08-skip-fallback-and-multi-on-gate.pipeline.yaml` | `decide` fans out to both `risky-step` and `safe-step`. `risky-step` is a leaf. `done` stays only on the safe-step arm (not a join across both). |
| `route-demo-multi-loop-targets` | `09-multi-loop-targets.pipeline.yaml` | Two *different* stages (`review`, `qa`) each declaring their own loop entry back to the *same* ancestor — `qa` loops to a stage two hops back, not its immediate parent. |
| `route-demo-uses-dialect-fork` | `10-uses-dialect-fork.pipeline.yaml` | `route`/`entry` combined with the `uses:` external-stage-file dialect — every other pipeline here uses inline `system_prompt`/`model` bodies instead. Both branches always run. |
| `route-demo-sequential-io` | `11-sequential-io-handoff.pipeline.yaml` | Sequential `io` handoff: parent `draft` `io.output.schema` and child `review` `io.input.schema` share the same object contract (`required: [title]`). `sf validate` is how users see this compatibility check. |
| `route-demo-complex-io` | `12-complex-io-schemas.pipeline.yaml` | Sequential `io` with pipeline `schemas:` (`finding`, `report`, `analyzed`): nested metadata, array of `$ref` items, enum/pattern/minLength/integer score. `draft → analyze → summarize`; summarize input is a subset (`title`/`summary`/`score` as number). Some `io` sides stay inline (`draft.in`, `summarize.in`/`out`). |
| `route-demo-ref-io` | `13-ref-io-handoff.pipeline.yaml` | Sequential `io` where **both** every `io.input.schema` and every `io.output.schema` is `$ref: "#/schemas/..."`. `draft.out` and `review.in` share `#/schemas/doc`; `ship.in` is `#/schemas/title-only` (subset of `analyzed`). Unlike `12`, no inline schema sides. |
| `route-demo-if-eq` | `14-if-eq-gating.pipeline.yaml` | Gated forward `if: { field: severity, op: eq, value: high }` to `page`, plus always-run `notify`. Default prompt emits `severity: low`, so `page` is skipped and the run succeeds. |
| `route-demo-if-all-gated` | `15-if-all-gated.pipeline.yaml` | Every forward `to:` has `if`. `sf validate` warns `pipeline.route_all_gated` with `ok: true`; `--strict` does not fail. |
| `route-demo-if-composition` | `16-if-composition.pipeline.yaml` | Nested `not` around `all`, dotted `customer.tier`, and `in`. Default prompt emits a miss, so `page` is skipped and always-run `notify` still runs. |
| `route-demo-if-join` | `17-if-join.pipeline.yaml` | Two-parent Join gated by inbound `if`s. `write` fires when `ready` is true; `draw` fires when `complete` is true. Default prompts emit both true, so `assemble` runs with both envelopes. Either miss skips `assemble`; the run still succeeds. |

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
`plan -> implement -> review` (review's `route` mixes a normal forward entry to `qa` with a `type: loop` entry back to `implement`, `max_replays: 2`, `on_max_replays: require_continue`, `replay_session: resume`) `-> qa` (fans out to both `ship` and `request-changes`) `-> ship` (fans out to `notify-slack`/`notify-email`/`update-changelog`) `-> close` (fan-in of request-changes plus the three notify stages; all four run on the happy path. The Join waits until every parent is terminal. With no inbound `if`, it runs if at least one succeeded. It stays pending if a parent failed. It does not run if every parent skipped).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/02-on-gating.pipeline.yaml --strict
```
Expect: **Validation passed.** `run-tests` lists `ship` (default succeeded) and `hotfix` with `on: [failed]`. `on: [failed]` opts hotfix out of skip-cascade when tests fail; hotfix does not launch; launch still needs a succeeded parent. Deterministic branching after success uses `if`.

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
Expect: **Validation passed.** Unconditional fan-out: `triage` lists `quick-fix` and `big-project` — both always run. `quick-fix` lists `notify-team`/`update-docs`/`schedule-followup` — all three always run. `close` fans in those three notify stages. `big-project` is a leaf.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/06-fan-out-fan-in.pipeline.yaml --strict
```
Expect: **Validation passed.** `kickoff`'s `route` list of three targets (`research`/`analysis`/`review-notes`) all fire unconditionally — parallel fan-out, no skipping. `synthesize` is the fan-in join: it waits for and combines all three, every run.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/07-loop-human-decision.pipeline.yaml --strict
```
Expect: **Validation passed.** The loop config variants `01-core-routing` doesn't exercise: `on_max_replays: wait_for_human` (vs. `require_continue`) and `replay_session: new_session` (vs. `resume`). `review`'s prompt always sends work back to `implement`; with `max_replays: 1`, the second send-back exhausts the budget and parks the run for a human decision instead of failing or looping forever.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/08-skip-fallback-and-multi-on-gate.pipeline.yaml --strict
```
Expect: **Validation passed.** `decide` lists both `risky-step` and `safe-step`, so both always run. `risky-step` is a leaf. `safe-step` routes to `notify-either-way` on success (the default `on:`), then `done`. `done` is only on that arm, not a join across both.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/09-multi-loop-targets.pipeline.yaml --strict
```
Expect: **Validation passed.** `review` and `qa` each declare their own `type: loop` entry back to `implement`. `review`'s stays dormant (always continues); `qa`'s fires once (sends back on its first attempt, continues on its second) — demonstrating a loop target that isn't the looping stage's immediate parent (`implement` is two hops back from `qa`), and two independent loop points converging on the same ancestor.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/10-uses-dialect-fork.pipeline.yaml --strict
```
Expect: **Validation passed.** Same fan-out shape as `05-fork-choice`'s `triage` (both listed branches always run), but every stage body lives in an external file under `stages/` and is loaded via `uses:` instead of inline `system_prompt`/`model` — confirms `route`/`entry` work identically under both stage-body dialects.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/11-sequential-io-handoff.pipeline.yaml --strict
```
Expect: **Validation passed.** Parent `draft` `io.output` matches child `review` `io.input` — the same object contract (`required: [title]`). This is the check users see from `sf validate` on sequential (non-clone) edges.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/12-complex-io-schemas.pipeline.yaml --strict
```
Expect: **Validation passed.** Three-stage `draft → analyze → summarize` with pipeline `schemas:` (`finding`, `report`, `analyzed`): nested metadata, array of `$ref` items, enum/pattern/minLength/integer score. `summarize` input is a subset (`title`/`summary`/`score` as number). Some `io` sides stay inline.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/13-ref-io-handoff.pipeline.yaml --strict
```
Expect: **Validation passed.** Every `io.input.schema` and `io.output.schema` is `$ref: "#/schemas/..."`. `draft.out` and `review.in` share `#/schemas/doc`; `ship.in` is `#/schemas/title-only` (subset of `analyzed`). Unlike `12`, both sides of every stage are `$ref`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/14-if-eq-gating.pipeline.yaml --strict
```
Expect: **Validation passed.** `triage` routes to `page` only when `severity` equals `high`, and always to `notify`. Mixed gated + always-run siblings do not warn `pipeline.route_all_gated`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/15-if-all-gated.pipeline.yaml --strict --json
```
Expect: **Validation passed** (`ok: true`) with warning `pipeline.route_all_gated`. `--strict` does not promote that warning to an error.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/16-if-composition.pipeline.yaml --strict
```
Expect: **Validation passed.** `page` is gated by `not` / `all` over `severity` and `customer.tier` `in` `[bronze]`. `notify` always runs. Nested required object paths are legal.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/17-if-join.pipeline.yaml --strict
```
Expect: **Validation passed.** `write` and `draw` both route to `assemble` with inbound `if`. Default prompts emit `ready: true` and `complete: true`, so the Join child runs with both success envelopes. Change either payload so the predicate misses and `assemble` is skipped (run still succeeds). A false `if` on one parent does not skip `assemble` while the other parent is still running.

## Rejected pipelines (should fail with the given message)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/01-reject-legacy-needs.pipeline.yaml --strict
```
Expect: `stage "review": "needs" is no longer supported — declare the wiring on the source stage's "route" instead`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/02-reject-legacy-fork.pipeline.yaml --strict
```
Expect: `stage "decide": "fork" is no longer supported — use "route" instead; listed route targets always run`

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
Expect: `stage "decide": "allow_none" is no longer supported — listed route targets always run`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/07-reject-cycle.pipeline.yaml --strict
```
Expect: `dependency cycle detected` — `a` routes to `b`, `b` routes back to `a`, as plain forward entries (not a loop).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/08-reject-loop-non-ancestor.pipeline.yaml --strict
```
Expect: `stage "b": feedback_loop target "c" must be an earlier ancestor` — `b`'s loop entry targets `c`, which is `a`'s other branch (a sibling), not an ancestor of `b`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/09-reject-route-select-leaf.pipeline.yaml --strict
```
Expect: `stage "decide": "route_select" is no longer supported — listed route targets always run` — the field itself is unsupported, including on a leaf.

```bash
```

```bash
```

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/12-reject-loop-replay-unsafe.pipeline.yaml --strict
```
Expect: `stage "review": feedback_loop target "implement" replays replay_safe: false stage "middle"` — a stage sitting on the replay route (between target and source) is marked `replay_safe: false`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/13-reject-multiple-loop-entries.pipeline.yaml --strict
```
Expect: `stage "review": route supports at most one loop entry, got 2` — two `type: loop` entries (with different, both-valid targets) on the same stage.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/14-reject-duplicate-stage-id.pipeline.yaml --strict
```
Expect: `Duplicate stage id "review" in ...` — two stage entries with the same `id` in one pipeline file. (Caught earlier, at the catalog/merge layer, before the route-specific checks even run.)

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/15-reject-unknown-route-target.pipeline.yaml --strict
```
Expect: `stage "draft" has unknown route target "nonexistent-stage"`

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/16-reject-malformed-route-item.pipeline.yaml --strict
```
Expect: `stage "draft": route item must have a non-empty "to" stage id` — a route entry with only `on:`, no `to:`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/17-reject-io-incompatible.pipeline.yaml --json
```
Expect: `io.input is not a structural subset` / `pipeline.io_incompatible` — `draft` outputs `verdict`, `review` requires `title`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/18-reject-nested-io.pipeline.yaml --json
```
Expect: `pipeline.io_incompatible` / `io.input is not a structural subset` — nested `metadata.owner.email` required on child, parent only has `metadata.source`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/19-reject-array-item-io.pipeline.yaml --json
```
Expect: `pipeline.io_incompatible` / `io.input is not a structural subset` — array items `$ref` child requires `severity`, parent items only `id`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/20-reject-closed-io.pipeline.yaml --json
```
Expect: `pipeline.io_incompatible` / `io.input is not a structural subset` — child `additionalProperties: false` while parent has extra `extra`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/21-reject-ref-io.pipeline.yaml --json
```
Expect: `pipeline.io_incompatible` — `draft.out` `$ref` `#/schemas/produced` vs `review.in` `$ref` `#/schemas/consumed` (`consumed` requires extra field `extra`).

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/22-reject-if-unknown-field.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — `if.field` is not a property of the source `io.output.schema`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/23-reject-if-optional-field.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — `if.field` is present on the output schema but not in `required`.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/24-reject-if-empty-all.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — empty `all:` list.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/25-reject-if-gt-on-string.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — numeric op `gt` on a string field.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/26-reject-if-optional-nested.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — nested path `customer.tier` is not required on the object schema.

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/27-reject-if-on-loop.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — `if` on a `{ type: loop }` Route Entry.

```bash
```

```bash
npx tsx src/cli.ts validate --pipeline examples/route-wiring-smoke-test/rejected/29-reject-if-on-failed.pipeline.yaml --json
```
Expect: `pipeline.route_if_invalid` — `if` combined with `on: [failed]`.

## Run from the UI / CLI

All 17 valid pipelines and `smoke-test.task.yaml` are registered in the repo-root `stageflow.yaml`. Point the UI at the local build (see "Important" above — either `npm link` first, or run the UI via `npx tsx src/cli.ts ui`):

```bash
npx tsx src/cli.ts ui
```

Start a new run, pick any of the 17 pipeline IDs from the table above, `route-smoke-test` as the task. Requires a Pi-compatible provider connected (`npx tsx src/cli.ts providers login` or via the UI's own connect flow) — actually executing a stage calls a real model, unlike the validate command above.

From the repo git root, run a pipeline with this worktree's CLI (never global `sf`):

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/01-core-routing.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/06-fan-out-fan-in.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/07-loop-human-decision.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

Pipeline `07` *will* stop and wait for a human — that's expected (`on_max_replays: wait_for_human`). Unstick it:

```bash
npx tsx src/cli.ts runs waiting
npx tsx src/cli.ts runs answer --run <runId> --stage review --answer '{"action":"continue"}'
```

(or the UI's own decide control).

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/11-sequential-io-handoff.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/12-complex-io-schemas.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/13-ref-io-handoff.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/14-if-eq-gating.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/16-if-composition.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

```bash
npx tsx src/cli.ts run \
  --pipeline examples/route-wiring-smoke-test/17-if-join.pipeline.yaml \
  --task examples/route-wiring-smoke-test/smoke-test.task.yaml
```

Pipelines **11–13** require the agent to emit the example payloads in each stage prompt (`11` draft: `{ "title": "<short string>" }`; `12` draft/analyze copy the `#/schemas/report` / `#/schemas/analyzed` examples; `13` draft/review copy the `#/schemas/doc` / `#/schemas/analyzed` examples). Review/summarize/ship may emit `payload: {}`.

- Want to watch a larger fan-out (triage plus three follow-ups from quick-fix)? Run `route-demo-fork-choice`.
- Want to watch true parallel fan-out/fan-in? Run `route-demo-fan-out-fan-in`.
- Want to practice the human-in-the-loop decision flow? Run `route-demo-loop-human-decision`.
- Want to see both arms of a fan-out run, with `done` only on the safe-step arm? Run `route-demo-skip-and-multi-on`.
- Want to see two loop points converging on one ancestor? Run `route-demo-multi-loop-targets` — it also parks briefly for a replay, same idea as `07`, but resolves itself (`require_continue`) rather than needing a human.
- Want to confirm the `uses:` dialect works the same as inline stage bodies? Run `route-demo-uses-dialect-fork`.
- Want to see a payload-gated `page` skip while `notify` still runs? Run `route-demo-if-eq`. The skipped stage is skipped, not a failed run.
- Want nested `all` / `not` and `customer.tier` `in`? Run `route-demo-if-composition`. Default payload misses, so `page` skips.
- Want to see a two-parent Join gated by inbound `if`s? Run `route-demo-if-join`. Default payloads match, so `assemble` runs with both envelopes.
- Want the broadest single flow, including notify stages that all run after ship? Run `route-demo-core`.

## What's still out of scope

A few things intentionally aren't in this catalog because they're orthogonal to the `route` migration (pre-existing features the migration didn't touch, not gaps in route coverage):

- **`gate_kinds`** / non-`feedback_loop` HITL gates — a stage-body concept, unrelated to wiring.
- **`verify`/`on_verify_fail`** completion contracts interacting with `route` — these fields pass through the migration completely unchanged; already covered by the existing (non-route) test suite.
- **`skill`/`mcp`** fields on a routed stage — capability wiring, unrelated to routing wiring.
- **The exact two-sequential-forks race timing** that caused the original "stuck-looking run" bug report — deliberately not turned into a hand-runnable example, since its whole point is a timing race that a live run can't reliably reproduce on demand. It lives only as an automated regression test: `tests/fixtures/pipelines/two-sequential-forks-join.pipeline.yaml` + `tests/runtime.genericFanIn.schedule.test.ts`.
