# Catalog mapping

How to turn a structure a person describes into Stageflow pipeline YAML: ids, wiring, human gates, proof, recovery, secrets and models, with worked examples. Exact key lists are in [yaml-reference.md](yaml-reference.md); prompt wording is in [stage-prompt-template.md](stage-prompt-template.md).

## Contents

- [Ids](#ids)
- [Sequencing](#sequencing)
- [on: skip-cascade policy](#on-skip-cascade-policy)
- [if: choosing successors](#if-choosing-successors)
- [Loops](#loops)
- [Human gates](#human-gates)
- [Review, then fix, then approve](#review-then-fix-then-approve)
- [Verify and on_verify_fail](#verify-and-on_verify_fail)
- [Clone Chain](#clone-chain)
- [Stage secrets](#stage-secrets)
- [Models](#models)
- [Worked examples](#worked-examples)

## Ids

One pipeline id, and one stage id per step. Ids match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`: a lowercase letter first, then lowercase letters, digits and single hyphens.

Derive each id from the person's own name for the step:

1. Lowercase it.
2. Replace each run of characters other than letters and digits with `-`.
3. Collapse repeated hyphens and trim them from both ends.
4. If it starts with a digit, prefix `x`. If it is empty, use `x`.
5. Cap at 64 characters and trim a trailing hyphen after the cut.

Before writing, check that `<id>.pipeline.yaml` or `<id>.yaml` does not already exist in the target directory. If it does, ask, or add a numeric suffix (`review-2`). The stage file name, its `id`, and the pipeline entry `id` must all be the same.

## Sequencing

Write the author dialect only: wiring with `route`, `entry: true` and `{ type: loop }`; contracts with `io`, `verify` and `on_verify_fail`. Wiring is declared on the source stage; a child never lists its parents. Once any stage has a `route`, mark every root `entry: true`. Every stage has `io.input.schema` and `io.output.schema`, and each child's input must be satisfied by each parent's output.

| The person says | Shape |
|---|---|
| Steps in order | First stage `entry: true`; each source lists `route: [{ to: next }]`. |
| Steps happen at the same time | The parent lists several `to:` with no `if`. All run after the parent succeeds. |
| A step waits for two or more earlier steps | Each parent lists `to: <join>`. The join declares nothing about its parents. |
| Exactly one of several next steps should run | The source lists every `to:` with `if`s on a required payload field whose conditions cannot be true together. Every matching `if` starts its target. The agent emits the field; it never names the next stage. |
| An optional extra step | `if` on that one `to:`; keep an ungated sibling for what always runs. |
| A review can send work back | `{ type: loop, to: <ancestor>, max_replays, on_max_replays, replay_session }` in the reviewer's `route`. |
| One run per item of a list | A Clone Chain: emitter, clone child, join. |
| Someone signs off | A gated stage; see [Human gates](#human-gates). |

Rejected wiring keys: `needs`, `fork`, an entry-level `feedback_loop`, `route_select`, `allow_none`, `clonable`, `clone_actions`.

## on: skip-cascade policy

Omit `on:` unless you need it. The default is `[succeeded]`. Adding `failed` or `skipped` stops a skip from cascading along that edge; it never launches a child from a failed or skipped parent.

- One parent: the child launches only when the parent succeeded. A skipped parent skips children whose `on` lacks `skipped`; with `skipped` in `on`, the child stays pending instead.
- Join (several parents with `to:` the same child): the join waits until every parent is terminal. It runs when at least one parent succeeded and none failed; skipped siblings do not block it. Any failed parent leaves it pending. If every parent skipped, it is skipped.

`on: [failed]` does not mean "run the hotfix stage when tests fail". For a branch after a check, have the check emit success with a discriminator and branch with `if`.

## if: choosing successors

`if` is evaluated after the source succeeds, against the source's payload only.

- Leaf `{ field, op, value }`, or `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }`.
- Ops `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, compared type-strictly (`1` is not `"1"`).
- `field` is a dot path; every segment must be a `required` property in the source's `io.output.schema`. Use an `enum` or a `boolean` so every value is covered.
- All matching entries fire; there is no first-match and no else. Unmatched successors are skipped.
- When every forward entry has an `if`, validation warns `pipeline.route_all_gated`. That is expected for an exclusive branch: two or more `if`s whose conditions cannot be true together. Every matching `if` starts its target.
- `if` is not allowed on a loop entry.

## Loops

A review that can send work back is a loop entry inside the reviewer's `route`:

- `to`: an ancestor of the reviewer.
- `max_replays`: how many send-backs are allowed (keep it small, 1 to 3).
- `on_max_replays`: `require_continue` (a further send-back is rejected at emit, so the reviewer must emit `continue`) or `wait_for_human` (the run parks until an operator decides to extend, continue or abandon).
- `replay_session`: `resume` (the replayed stage keeps its session and sees the feedback) or `new_session`.

The reviewer's success envelope then carries `feedback_loop: { action: continue }` to move on, or `{ action: send_back, target: <ancestor> }` to replay. YAML never has a `feedback_loop:` key. Mark one-shot side-effecting stages `replay_safe: false` and keep them outside the replay range.

When the person wants a separate fix step rather than redoing an earlier one, a forward review, fix, approve chain is clearer than a loop.

## Human gates

A stage asks a person with the `ask_operator` tool, which exists only when the stage lists `gate_kinds`:

| Kind | Use |
|---|---|
| `confirm` | Yes or no. |
| `free_text` | An open answer or clarification. |
| `artifact_backed` | Accept or reject a file the stage wrote with `write_stage_artifact`. |
| `multi_question` | Several questions in one prompt. |

- **Advisory gate:** `gate_kinds` only. The agent may ask, but nothing forces it.
- **Load-bearing gate:** `gate_kinds` plus `verify: [{ id: <id>, type: gate, kind: <kind> }]`. A success emit without an accepted or answered exchange is rejected. The `kind` must appear in `gate_kinds`.

`ask_operator` never completes a stage; only `emit_stage_envelope` does. The prompt sequence is: write the artifact, ask, revise and ask again on reject in the same attempt, and emit only after accept. `artifact_backed` paths are the run-relative paths that `write_stage_artifact` returns, never checkout paths.

## Review, then fix, then approve

When a review can demand changes and a later stage approves or ships:

```
... -> review -> address-feedback -> approve
```

Do not make approve or ship the direct child of a review that is expected to find blockers. The review stage's output carries `verdict` and `blocking_findings`; address-feedback is the only stage that edits after review; approve is the backstop gate. When the person prefers sending work back to the earlier stage, use a loop instead.

## Verify and on_verify_fail

`verify` lives on the stage body; `on_verify_fail` lives on the pipeline entry.

| Need | YAML |
|---|---|
| A named file must exist after the stage | `verify: [{ id, type: artifact, path: report.md, nonempty: true, when: [after] }]` |
| A file must be listed when the stage emits | `verify: [{ id, type: artifact, basename: report.md, when: [emit] }]` |
| Sign-off must happen in this attempt | `type: gate` with a `kind` from `gate_kinds` |
| An implementation must change the checkout | `type: checkout_changes`, `path_fields: [changed_files]`, with `changed_files` a required string array in `io.output.schema` |
| Tests or a linter must pass | `type: command`, `run: <command>`; the stage prompt must not claim to have run it |
| Every listed step was done | `type: checklist`, `items: [...]`; the envelope attests them in `checklist_attestations` |
| Retry automatically when an after check fails | `on_verify_fail: { mode: repair, max_attempts: 2, retry_safety: idempotent, include_failed_checks: true }` |
| Stop for a person when a side-effecting stage fails a check | `on_verify_fail: { mode: manual, retry_safety: side_effecting }` |

`on_verify_fail` needs at least one after-phase check on that stage. Check `id`s are unique within a stage. Prompts alone do not enforce anything; put the rule in `verify` when it matters.

## Clone Chain

One run per list item is an emitter, a clone child and a join:

- The emitter's `io.output.schema` has exactly one array whose `items` is a named `$ref`. The clone child's whole `io.input.schema` is that same `$ref`.
- `clone_cap` (integer, at least 1) and `clone_mode` (`parallel` or `sequential`) go on the emitter's pipeline entry, never in a stage body.
- The emitter routes only to the clone child, and the clone child only to the join, with no `if`.
- An empty list or one longer than `clone_cap` fails the emitter's emit; nothing is skipped or truncated. Put a check before the emitter if the list can be empty.
- Instances run as `<child>~1`, `<child>~2`, and so on. The join receives every instance's envelope in list order.
- The join may loop only to a stage before the emitter. The emitter, child and join are not loop targets, and the child cannot send back.
- A pipeline with any Clone Chain cannot be published over A2A.

```yaml
id: per-item-review
model: CHANGE_ME/<provider-model>
schemas:
  item:
    type: object
    required: [name]
    properties:
      name: { type: string }
stages:
  - id: split
    entry: true
    clone_cap: 5
    clone_mode: parallel
    route:
      - to: review-item
    system_prompt: |
      List the items to review from the task input. Emit a success envelope
      whose payload.items has one entry per item (1 to 5 entries).
    io:
      input: { schema: { type: object } }
      output:
        schema:
          type: object
          required: [items]
          properties:
            items:
              type: array
              items: { $ref: "#/schemas/item" }
  - id: review-item
    route:
      - to: combine
    system_prompt: |
      Your input is one item. Review that item only and emit a success
      envelope with a payload containing verdict.
    io:
      input: { schema: { $ref: "#/schemas/item" } }
      output:
        schema:
          type: object
          required: [verdict]
          properties:
            verdict: { type: string }
  - id: combine
    system_prompt: |
      You receive every item review in list order. Combine them into
      summary.md with write_stage_artifact and emit success.
    io:
      input: { schema: { type: object } }
      output: { schema: { type: object } }
```

## Stage secrets

Stages get a curated environment, not the Host's environment. A credential reaches a stage only when it is named in `secrets:` on the stage body or on its `uses:` wrapper:

```yaml
secrets:
  - GITHUB_TOKEN
  - { name: NPM_TOKEN, as: env }
```

- A plain name for `GITHUB_TOKEN` or `GH_TOKEN` sets up git credential askpass and a token file, not a raw environment variable. Use `{ name: GITHUB_TOKEN, as: env }` when `gh` or an MCP server needs the variable; askpass stays on for plain HTTPS git.
- The name must be in the Host's secret registry (`stage.unknown_secret` otherwise): `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` always are; others are added by the operator through `STAGEFLOW_SECRET_REGISTRY`, a file credential, or a console-saved MCP secret. Never list `STAGEFLOW_CONTROL_TOKEN` or read tokens; they can never be granted.
- The value lives on the Host only. Never write a value into YAML, a task or a prompt.
- When a stage runs `gh` or another tool, add `requires: [{ tool: gh }]` so `sf doctor --pipeline` can check it. Stageflow never installs tools.

## Models

Set the model once on the pipeline (or rely on `stageflow.yaml`), and override per stage only for a reason. Take ids from MCP `list_models` or the configured providers in `sf providers status`; when none is known, write `CHANGE_ME/<provider-model>` and tell the person. Siblings after a fan-out share a model family unless the person asks otherwise. Prefer a reliable model on stages with side effects.

## Worked examples

Complete files for the first three are in `assets/examples/`.

### Review loop (linear)

Three steps; the middle one is a sign-off. Revisions stay inside the gated `review` stage.

```yaml
id: review-loop
model: CHANGE_ME/<provider-model>
stages:
  - id: draft
    uses: ./draft.yaml
    entry: true
    route:
      - to: review
  - id: review
    uses: ./review.yaml
    route:
      - to: publish
    on_verify_fail:
      mode: repair
      max_attempts: 3
      retry_safety: idempotent
      include_failed_checks: true
  - id: publish
    uses: ./publish.yaml
    on_verify_fail:
      mode: manual
      retry_safety: side_effecting
```

`review.yaml` has `gate_kinds: [artifact_backed]`, an emit-phase gate check and an after-phase artifact check. Files: `assets/examples/linear-review/`.

### Release gate (exclusive branch)

`run-tests` emits success with a required boolean `ready`. The two `if`s cannot both be true. Every matching `if` starts its target. A failure emit launches neither child.

```yaml
id: release-gate
model: CHANGE_ME/<provider-model>
stages:
  - id: run-tests
    uses: ./run-tests.yaml
    entry: true
    route:
      - to: ship
        if:
          field: ready
          op: eq
          value: true
      - to: hotfix
        if:
          field: ready
          op: eq
          value: false
  - id: hotfix
    uses: ./hotfix.yaml
  - id: ship
    uses: ./ship.yaml
    on_verify_fail:
      mode: manual
      retry_safety: side_effecting
```

Files: `assets/examples/branch-decision/`.

### Research digest (not software)

Gather, summarize, send: the same linear chain, with ids and prompts in the person's domain. Files: `assets/examples/non-sdlc-digest/`.

### Fan-out and join

"After intake, collect quotes and notes at the same time, then synthesize both":

```yaml
id: intake-fan-out
model: CHANGE_ME/<provider-model>
stages:
  - id: intake
    uses: ./intake.yaml
    entry: true
    route:
      - to: collect-quotes
      - to: collect-notes
  - id: collect-quotes
    uses: ./collect-quotes.yaml
    route:
      - to: synthesize
  - id: collect-notes
    uses: ./collect-notes.yaml
    route:
      - to: synthesize
  - id: synthesize
    uses: ./synthesize.yaml
```

The join reads each parent's envelope by stage id. Its `io.input.schema` must be satisfied by both parents' outputs, so keep it `{ type: object }` or require only fields both parents produce.

### Review sends work back (loop)

```yaml
id: implement-loop
model: CHANGE_ME/<provider-model>
stages:
  - id: implement
    uses: ./implement.yaml
    entry: true
    route:
      - to: review
  - id: review
    uses: ./review.yaml
    route:
      - to: submit
      - type: loop
        to: implement
        max_replays: 2
        on_max_replays: require_continue
        replay_session: resume
  - id: submit
    uses: ./submit.yaml
    replay_safe: false
```

The review's success emit carries `feedback_loop: { action: continue }` or `{ action: send_back, target: implement }`. A fuller version with checkout proof, tests and a gated plan is `assets/examples/implement-review/`.
