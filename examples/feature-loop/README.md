# feature-loop

Epic-to-PR walkthrough: split a requirements document into stories,
plan them in parallel, align the plans, implement them **sequentially**,
verify nothing was missed, review the whole diff, fix review blockers
(with a send-back loop), then open an operator-approved pull request.

This is the shape for work that starts as one epic and must not land
as overlapping parallel edits. It is repository-neutral — point the
task `checkout` at a feature branch of whatever tree you are shipping.
Nothing in the stage files names a product, repo, or keyword.

## Flow

```
decompose ──fanout parallel──► plan~N ──join──► align
                                           │
                          sequential fanout │
                                           ▼
                              implement~1 → implement~2 → …
                                           │
                                           ▼
                         verify → review ⇄ address-feedback → publish
```

1. **decompose** — Read the epic (task + requirements doc). Cut 1–8
   independent stories. Emit `clone_forks` to `plan` (`once` or
   `fanout` / `parallel`). Writes `epic-split.md`.
2. **plan** (clonable) — One clone per story. Research the checkout and
   write `story-plan.md` (edit sites, validation commands, neighbor
   boundaries). No source edits.
3. **align** — Join every plan clone. Fix overlapping files and
   contradictions, choose **implementation order**, ask the operator to
   accept `aligned-plans.md`, then emit `clone_forks` to `implement`
   with `mode: sequential`.
4. **implement** (clonable, sequential) — Clone `~1` runs first; `~N`
   starts only after `~N-1` succeeded, so earlier edits are already in
   the tree. Each clone executes only its story (ce-work style) and
   must change the checkout.
5. **verify** — Join implement clones. Fail if any aligned `story_id`
   is missing from the clone list or the union diff. Writes `coverage.md`.
6. **review** — One whole-diff review of every story together
   (ce-code-review style). Report-only. `verdict: pass | changes_required`.
7. **address-feedback** — Fix blockers. `feedback_loop` `send_back` to
   `review` when the tree changed so the whole diff is re-read;
   `continue` when review is clean. After two send-backs the run waits
   for an operator decision. `publish` is `replay_safe: false`.
8. **publish** — Operator accepts `ship-package.md`, then this same
   attempt commits, pushes the current branch, and opens the PR.

No stage before `publish` commits, pushes, or opens a PR. No stage
creates or switches branches.

## Runtime contracts

| Stage | Clonable | Gate | Required artifacts | Other checks |
|-------|----------|------|--------------------|--------------|
| `decompose` | parent of `plan` | — | `epic-split.md` | `clone_forks` once/fanout parallel |
| `plan` | yes, cap 8 | — | `story-plan.md` | `io.input` assignment |
| `align` | parent of `implement` | `artifact_backed` | `aligned-plans.md` | sequential `clone_forks` |
| `implement` | yes, cap 8 | — | `implementation-report.md` | `checkout_changes` |
| `verify` | join | — | `coverage.md` | `io.output` |
| `review` | — | — | `review-report.md` | whole-diff, report-only |
| `address-feedback` | — | — | `review-feedback-report.md` | `feedback_loop` → `review` |
| `publish` | — | `artifact_backed` | `ship-package.md`, `pull-request.md` | `on_verify_fail: manual` |

`on_verify_fail` repair (idempotent, 3 attempts) sits on every stage except
`publish` (`manual` / `side_effecting`). Stage files use `io` / `verify`;
this release still loads the previous field names — see
[YAML catalog — Dual-read](../../docs/yaml-catalog.md#dual-read-this-release).

`plan` clones are **parallel** so stories can be refined at the same
time. `implement` clones are **sequential** so shared files do not
race. A clone-list join still waits until every clone of that parent
succeeded.

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

Inspect clone tracks and envelopes in the operator console (`sf ui`)
on the `plan` and `implement` stages, then the `align` / `verify` joins.
