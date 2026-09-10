# Catalog mapping

Turn the confirmed step list into one pipeline id and one stage id per step. Ids follow `STAGE_ID_PATTERN`: start with a letter, then lowercase letters, digits, and single hyphens (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`).

Derive each id from the human's name for that step or loop:

1. Lowercase.
2. Replace each run of non-alphanumeric characters with `-`.
3. Collapse repeated hyphens; trim leading and trailing hyphens.
4. If the first character is a digit, prefix `x`.
5. If the result is empty, use `x`.
6. Cap at 64 characters; trim a trailing hyphen after the cut.
7. Keep the result only when it matches the pattern.

Collision handling lives in [`catalog-write-conventions.md`](catalog-write-conventions.md).

## Sequencing

`needs` is a parent stage id, or a non-empty array (length ≥ 1). Strings default to `on: [succeeded]`. `{ id, on }` accepts a non-empty unique subset of `succeeded` | `failed` | `skipped`.

| Human says | Pipeline shape |
|---|---|
| Steps in order | Each later stage `needs` the previous id. No `fork` field. |
| Steps happen together | Sibling stages share one `needs` (the same parent). No `fork` field. |
| A later step waits for two or more earlier steps | That stage `needs` an array of those parent ids (length ≥ 2). |
| Exactly one branch runs | Deciding stage gets `fork: { select: one }`. Each branch `needs` the decider. |
| Either, both, or a subset may run | Deciding stage gets `fork: { select: subset }`. Each branch `needs` the decider. |

Default `select` is `one` unless the human says more than one branch can run.

Map linear chains, sibling fan-out, generic fan-in (`needs` array), and single-level `fork`.

A review, approval, or sign-off step is a gated stage: put `gate_kinds` on that stage file and follow [`stage-prompt-template.md`](stage-prompt-template.md).

## Review then fix then approve

When the human wants a review that can demand changes, then a later approve/ship:

```
… → review → address-feedback → approve
```

Do not wire approve/ship as the immediate child of review. Pipelines are forward-only; without an address-feedback stage, blocking findings have nowhere to land. The address-feedback stage is the only post-review editor; the approve stage is the backstop.

## Verify and on_verify_fail

Put `verify` on the **stage body** (the `uses:` file or inline entry). Put `on_verify_fail` on the **pipeline** stage entry (the `uses:` wrapper). Use when the human needs a hard gate before advance:

| Need | Catalog |
|---|---|
| Required file under the attempt artifact dir | `verify` with `type: artifact`, `path`, usually `nonempty: true`, `when: [after]` |
| HITL must complete this attempt | `type: gate` with `kind` that appears in the stage's `gate_kinds` (default `when: [emit]`) |
| Implement must change the checkout | `type: checkout_changes` with `path_fields` naming required arrays in `io.output.schema` |
| Auto-retry when after-phase verify fails | `on_verify_fail: { mode: repair, max_attempts: N, retry_safety: idempotent, include_failed_checks: true }` |
| Side-effecting publish / ship | `on_verify_fail: { mode: manual, retry_safety: side_effecting }` |

`on_verify_fail` requires at least one after-phase `verify` item. Check `id` values must be unique within the stage. Check discriminator is `type:` (gate widgets still use `kind:`). Wire these for writer stages and final gates; prompts alone do not enforce them.

## Clonable successors

A runtime clone count is not knowable from a vague description — leave `clonable` and `clone_forks` unset and prefer sibling stages or a single review.

When the human explicitly wants N parallel instances of **one** successor catalog id (e.g. several review lenses, several prototype variants):

- On that successor pipeline entry: `clonable: true` and `clone_cap` (integer ≥ 2).
- That successor must have at least one child (a join / address-feedback / collect stage). It cannot be a DAG leaf.
- Parent success emit uses `clone_forks` for that successor (not `fork_choice`). Each clone assignment is a full envelope; validate assignments with `io.input.schema` on the clonable stage body.
- Join stages that wait on the clonable parent read clone-list `priorEnvelopes`, not `priorEnvelopesByStage`.

`fork` + `fork_choice` picks which **branch stage ids** run. `clone_forks` spawns **N instances** of one successor id.

## Models

Confirm providers before writing. After a fork, give every sibling the same configured `model` unless the human asks for different ones. Prefer a reliable configured model on side-effecting final stages.

## Worked examples

### Review loop (linear)

Three sequential steps; the middle one is a sign-off. Reject/revise stays inside the gated `review` stage.

```yaml
id: review-loop
model: anthropic/claude-sonnet-4-5
stages:
  - id: draft
    uses: ./draft.yaml
  - id: review
    uses: ./review.yaml
    needs: [draft]
  - id: publish
    uses: ./publish.yaml
    needs: [review]
```

`review` carries `gate_kinds: [artifact_backed]` and emit-phase `verify` `type: gate`. Full set: [`../assets/examples/linear-review/`](../assets/examples/linear-review/).

### Review with separate fix stage

When review can emit blockers and a later stage approves or ships, insert address-feedback between them:

```yaml
stages:
  - id: implement
    uses: ./implement.yaml
  - id: review
    uses: ./review.yaml
    needs: [implement]
  - id: address-feedback
    uses: ./address-feedback.yaml
    needs: [review]
  - id: approve
    uses: ./approve.yaml
    needs: [address-feedback]
```

Do not make `approve` / `ship` `needs: review` when blockers are expected.

### Release gate (fork, select one)

One deciding step, then exactly one successor.

```yaml
id: release-gate
stages:
  - id: run-tests
    uses: ./run-tests.yaml
    fork:
      select: one
  - id: hotfix
    uses: ./hotfix.yaml
    needs: [run-tests]
  - id: ship
    uses: ./ship.yaml
    needs: [run-tests]
```

Full set: [`../assets/examples/branch-decision/`](../assets/examples/branch-decision/).

### Research digest (linear, non-software)

Weekly gather → summarize → send. Same `needs` chain as the review loop; ids and prompts stay in that domain.

```yaml
id: research-digest
stages:
  - id: gather
    uses: ./gather.yaml
  - id: summarize
    uses: ./summarize.yaml
    needs: [gather]
  - id: send
    uses: ./send.yaml
    needs: [summarize]
```

Full set: [`../assets/examples/non-sdlc-digest/`](../assets/examples/non-sdlc-digest/).

### Sibling fan-out

"After intake, collect quotes and collect notes at the same time":

```yaml
stages:
  - id: intake
    uses: ./intake.yaml
  - id: collect-quotes
    uses: ./collect-quotes.yaml
    needs: [intake]
  - id: collect-notes
    uses: ./collect-notes.yaml
    needs: [intake]
```

No `fork` field. Both siblings run.

### Diamond join

"After research and validation both finish, synthesize":

```yaml
stages:
  - id: clarify
    uses: ./clarify.yaml
  - id: research
    uses: ./research.yaml
    needs: [clarify]
  - id: validation
    uses: ./validation.yaml
    needs: [clarify]
  - id: synthesize
    uses: ./synthesize.yaml
    needs:
      - research
      - validation
```

`needs` array length ≥ 2 is keyed fan-in. The join reads `priorEnvelopesByStage`, not clone-list `priorEnvelopes`.

### Fork, select subset

"Email, post, or both could go out":

```yaml
stages:
  - id: choose-channels
    uses: ./choose-channels.yaml
    fork:
      select: subset
  - id: email
    uses: ./email.yaml
    needs: [choose-channels]
  - id: post
    uses: ./post.yaml
    needs: [choose-channels]
```

The success emit names one or more of those successor ids in `fork_choice`.
