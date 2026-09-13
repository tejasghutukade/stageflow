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

Write **Author YAML only**:

- Wiring: `route` / `entry: true` / `{ type: loop }`
- Contracts: `io` / `verify` / `on_verify_fail`
- Every stage body has `io.input.schema` and `io.output.schema`
- Sequential and fan-in edges: consumer `io.input` must be a structural subset of **each** parent's `io.output`

Wiring is declared on the **source** stage. Children do not list parents. A pipeline that uses `route` must mark at least one `entry: true` root.

`route` is a list of entries. Forward entries name `to:`, optional `on:`, optional `if`. Load rejects `needs`, `fork`, `feedback_loop`, `route_select`, and `allow_none`.

| Human says | Pipeline shape |
|---|---|
| Steps in order | First stage `entry: true`. Each source lists `route: [{ to: next }]`. |
| Steps happen together | Parent lists multiple `to:` with no `if`. Both run after the parent succeeds. |
| A later step waits for two or more earlier steps | Each parent lists `to: join`. The join does not declare parents. |
| Exactly one of several successors should run | Source lists every `to:` with mutually exclusive `if`s on a required payload field. Agent emits that field; it does not name successor ids. |
| Optional extra successor | `if` on that `to:`. Keep an ungated sibling if something should always run. |
| Review can send work back | Source `route` includes `{ type: loop, to: ancestor, max_replays, on_max_replays, replay_session }`. Success emit includes envelope `feedback_loop`. |

A review, approval, or sign-off step is a gated stage: put `gate_kinds` on that stage file and follow [`stage-prompt-template.md`](stage-prompt-template.md).

### `on:` (skip-cascade policy, not a launch)

Default is succeeded-only. Omit `on:` unless you need to opt an edge out of skip-cascade.

Including `failed` or `skipped` in `on:` opts that edge out of skip-cascade. It does **not** launch a child from a skipped or failed parent.

- Single-parent: launch still requires a **succeeded** parent. A skipped parent skip-cascades children whose `on` does **not** include `skipped`. Including `skipped` only prevents cascade; the child stays pending.
- Multi-parent Join (two or more parents each listing `to:` the same child): never skip-cascaded from one parent. Wait until every parent is terminal. Runs if at least one parent succeeded (skipped siblings do not block). Stays pending if any parent failed (even if `on` lists `failed`). Force-skipped if every parent skipped.

For exclusive branching after a check, emit **success** with a required discriminator in `io.output.schema` and gate successors with `if`. `on: [failed]` does not mean “run hotfix when tests fail” — that child will not launch.

### `if` (runtime gate after success)

Evaluated after the source **succeeds**, against that source's output payload only.

Leaf `{ field, op, value }` or composition `{ all: [...] }` | `{ any: [...] }` | `{ not: {...} }`.

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`. Type-strict (`1` is not `"1"`).

`field` is a dot-separated path; every segment must be a **required** object property in the source `io.output.schema`.

Two matching `if`s both fire (not first-match-wins).

When every forward `to:` on a stage has `if`, validate warns `pipeline.route_all_gated` (`ok: true`; `--strict` does not promote). That is acceptable for exclusive branches.

`if` is illegal on `{ type: loop }`, or combined with `on` other than succeeded-only.

The completing agent does **not** pick which successors run. Do not emit `fork_choice`.

### Loops

A review that can send work back to an ancestor is a `{ type: loop }` entry **inside** `route` on the source (the reviewer). Required fields: `type: loop`, `to` (earlier ancestor), `max_replays`, `on_max_replays` (`require_continue` | `wait_for_human`), `replay_session` (`resume` | `new_session`).

The **envelope** field on emit is still `feedback_loop` (`continue` / `send_back`). Catalog YAML does not use a `feedback_loop:` key.

Optional `replay_safe: false` on stages that must not be replayed (e.g. one-shot submit).

Forward-only “review → address-feedback → approve” is still the right map when the human wants a separate fix stage rather than send-back.

## Review then fix then approve

When the human wants a review that can demand changes, then a later approve/ship:

```
… → review → address-feedback → approve
```

Do not wire approve/ship as the immediate child of review when blockers are expected. The address-feedback stage is the only post-review editor; the approve stage is the backstop. When they want send-back to an earlier stage instead, put `{ type: loop }` on the reviewer's `route`.

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

## Clone Chain

A Clone Chain is emitter → clone child → Join. The emitter output has exactly one array of a named `$ref`; the clone child's entire input is that same `$ref`. Put `clone_cap` (integer ≥ 1) and `clone_mode` (`parallel` | `sequential`) on the **emitter pipeline entry**, not on the stage body. N=1 still mints `{child}~1`. See [Clone Chain spec](../../../docs/specs/clone-chain.md) and [`clone-chain-smallest.pipeline.yaml`](../../../tests/fixtures/pipelines/clone-chain-smallest.pipeline.yaml).

## Rejected clone fields

Do not author `clonable`, `clone_actions`, or envelope `clone_forks`. Do not put `clone_cap` / `clone_mode` on a stage that is not a Clone Chain emitter.

## Models

Confirm providers before writing. After fan-out, give every sibling the same configured `model` unless the human asks for different ones. Prefer a reliable configured model on side-effecting final stages.

## Worked examples

### Review loop (linear)

Three sequential steps; the middle one is a sign-off. Reject/revise stays inside the gated `review` stage.

```yaml
id: review-loop
model: anthropic/claude-sonnet-4-5
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

`review` carries `gate_kinds: [artifact_backed]` and emit-phase `verify` `type: gate`. Full set: [`../assets/examples/linear-review/`](../assets/examples/linear-review/).

### Review with separate fix stage

When review can emit blockers and a later stage approves or ships, insert address-feedback between them:

```yaml
stages:
  - id: implement
    uses: ./implement.yaml
    entry: true
    route:
      - to: review
  - id: review
    uses: ./review.yaml
    route:
      - to: address-feedback
  - id: address-feedback
    uses: ./address-feedback.yaml
    route:
      - to: approve
  - id: approve
    uses: ./approve.yaml
```

Do not wire approve/ship as the immediate child of review when blockers are expected.

### Release gate (exclusive via `if`)

`run-tests` emits **success** with required `ready` boolean. Catalog `if` picks the successor. A failure emit would leave both children unlaunched.

```yaml
id: release-gate
model: anthropic/claude-sonnet-4-5
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

Full set: [`../assets/examples/branch-decision/`](../assets/examples/branch-decision/).

### Research digest (linear, non-software)

Weekly gather → summarize → send. Same `entry` + `route` chain as the review loop; ids and prompts stay in that domain.

```yaml
id: research-digest
model: anthropic/claude-sonnet-4-5
stages:
  - id: gather
    uses: ./gather.yaml
    entry: true
    route:
      - to: summarize
  - id: summarize
    uses: ./summarize.yaml
    route:
      - to: send
  - id: send
    uses: ./send.yaml
    on_verify_fail:
      mode: manual
      retry_safety: side_effecting
```

Full set: [`../assets/examples/non-sdlc-digest/`](../assets/examples/non-sdlc-digest/).

### Sibling fan-out

"After intake, collect quotes and collect notes at the same time":

```yaml
stages:
  - id: intake
    uses: ./intake.yaml
    entry: true
    route:
      - to: collect-quotes
      - to: collect-notes
  - id: collect-quotes
    uses: ./collect-quotes.yaml
  - id: collect-notes
    uses: ./collect-notes.yaml
```

Both run after intake succeeds. No `if`.

### Diamond join

"After research and validation both finish, synthesize":

```yaml
stages:
  - id: clarify
    uses: ./clarify.yaml
    entry: true
    route:
      - to: research
      - to: validation
  - id: research
    uses: ./research.yaml
    route:
      - to: synthesize
  - id: validation
    uses: ./validation.yaml
    route:
      - to: synthesize
  - id: synthesize
    uses: ./synthesize.yaml
```

The join reads `priorEnvelopesByStage`, not a list of sibling envelopes. A skipped sibling does not block. A failed parent leaves the join pending.

### Optional / subset fan-out

"Email, post, or both": list both `to:` with no `if` (both run). To skip a channel, add `if` on that `to:` and put the discriminator in `io.output.schema`. Do not emit `fork_choice`.

```yaml
stages:
  - id: choose-channels
    uses: ./choose-channels.yaml
    entry: true
    route:
      - to: email
      - to: post
  - id: email
    uses: ./email.yaml
  - id: post
    uses: ./post.yaml
```

To skip a channel, add `if` on that `to:` (keep an ungated sibling if the other channel should always run).

### Review send-back (loop)

```yaml
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

Success emit from `review` includes envelope `feedback_loop`: `{ action: continue }` or `{ action: send_back, target: implement }`.
