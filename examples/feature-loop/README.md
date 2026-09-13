# feature-loop

Epic-to-PR walkthrough: split a requirements document into stories,
plan them in parallel, align the plans, implement them **sequentially**,
verify nothing was missed, review the whole diff, fix review blockers
(with a send-back loop), then open an operator-approved pull request.

This is the shape for work that starts as one epic and must not land
as overlapping parallel edits. It is repository-neutral — point the
task `checkout` at a feature branch of whatever tree you are shipping.
Nothing in the stage files names a product, repo, or keyword.

The shipped YAML is two sealed [Clone Chains](../../docs/yaml-catalog.md#clone-chain)
plus a `{ type: loop }` from `address-feedback` back to `review`. Wiring
is outbound `route` (`entry`, `clone_cap` / `clone_mode` on emitters).
`sf validate --strict` against this pipeline is expected to pass.

## Flow

```
decompose ──Clone Array (parallel)──► plan~N ──Join──► align
                                           │
                    sequential Clone Array │
                                           ▼
                              implement~1 → implement~2 → …
                                           │
                                           ▼
                         verify → review ⇄ address-feedback → publish
```

1. **decompose** — Read the epic (task + requirements doc). Cut 1–8
   stories into a Clone Array (`stories` items `$ref` `story-assignment`).
   Writes `epic-split.md`. Emitter: `clone_cap: 8`, `clone_mode: parallel`.
2. **plan** — One Clone Instance per story (`clone_mode: parallel`). Each
   writes `story-plan.md` (edit sites, validation commands, neighbor
   boundaries). No source edits. Entire `io.input.schema` is
   `{ $ref: "#/schemas/story-assignment" }`.
3. **align** — Join of every plan Clone Instance. Fix overlapping files and
   contradictions, choose **implementation order**, ask the operator to
   accept. Then this stage is the emitter of the next Clone Chain
   (`clone_mode: sequential`): `stories` items `$ref` `story-work`, with
   `order` / `depends_on` on each item.
4. **implement** — Sequential Clone Instances in array order; `~N`
   starts only after `~N-1` succeeded, so earlier edits are already in
   the tree. Each instance executes only its story and must change the
   checkout. Entire `io.input.schema` is `{ $ref: "#/schemas/story-work" }`.
5. **verify** — Join of implement Clone Instances. Fail if any aligned
   `story_id` is missing from the instance set or the union diff. Writes
   `coverage.md`.
6. **review** — One whole-diff review of every story together
   (ce-code-review style). Report-only. `verdict: pass | changes_required`.
7. **address-feedback** — Fix blockers. Envelope `feedback_loop`
   `send_back` to `review` when the tree changed so the whole diff is re-read;
   `continue` when review is clean. Catalog loop:
   `{ type: loop, to: review, max_replays: 2, on_max_replays: wait_for_human,
   replay_session: new_session }`. After two send-backs the run waits
   for an operator decision. `publish` is `replay_safe: false`.
8. **publish** — Operator accepts `ship-package.md`, then this same
   attempt commits, pushes the current branch, and opens the PR.

No stage before `publish` commits, pushes, or opens a PR. No stage
creates or switches branches.

## Runtime contracts

| Stage | Gate | Required artifacts | Other checks |
|-------|------|--------------------|--------------|
| `plan` | — | `story-plan.md` | `io.input` assignment |
| `implement` | — | `implementation-report.md` | `checkout_changes` |
| `verify` | — | `coverage.md` | `io.output` |
| `review` | — | `review-report.md` | whole-diff, report-only |
| `address-feedback` | — | `review-feedback-report.md` | `{ type: loop }` → `review` |
| `publish` | `artifact_backed` | `ship-package.md`, `pull-request.md` | `on_verify_fail: manual` |

`on_verify_fail` repair (idempotent, 3 attempts) sits on every stage except
`publish` (`manual` / `side_effecting`). Stage files use `io` / `verify` /
`on_verify_fail`.

Shared JSON Schema lives on the pipeline under `schemas:` —
`story-assignment` is the first Clone Array item (`plan` input `$ref`);
`story-work` is the second (`implement` input `$ref`). See
[YAML catalog — Pipeline schemas](../../docs/yaml-catalog.md#pipeline-schemas)
and [Clone Chain](../../docs/yaml-catalog.md#clone-chain).

## Run

Fill in [`feature-loop.task.yaml`](feature-loop.task.yaml) (epic path,
publish repo, base branch, `checkout` on the feature branch). Operator
accepts twice: aligned plans, then the ship package.

```bash
node dist/cli.js validate --pipeline examples/feature-loop/feature-loop.pipeline.yaml --strict
node dist/cli.js run \
  --pipeline examples/feature-loop/feature-loop.pipeline.yaml \
  --task examples/feature-loop/feature-loop.task.yaml
```

Needs a configured provider (`sf providers status`), `gh` on PATH, and
`GH_TOKEN` or `GITHUB_TOKEN` for the publish stage. Optional: add
`mcp: [context7]` on the `plan` pipeline entry when `CONTEXT7_API_KEY`
is set so story plans can query current library docs.

Inspect Clone Instance tracks and envelopes in the operator console (`sf ui`)
on the `plan` and `implement` stages, then the `align` / `verify` Joins.
