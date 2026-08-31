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

`needs` is a single parent stage id. Fan-in (one stage needing two parents) is out of catalog shape.

| Human says | Pipeline shape |
|---|---|
| Steps in order | Each later stage `needs` the previous id. No `fork` field. |
| Steps happen together | Sibling stages share one `needs` (the same parent). No `fork` field. |
| Exactly one branch runs | Deciding stage gets `fork: { select: one }`. Each branch `needs` the decider. |
| Either, both, or a subset may run | Deciding stage gets `fork: { select: subset }`. Each branch `needs` the decider. |

Default `select` is `one` unless the human says more than one branch can run.

Map linear chains, sibling fan-out, and single-level `fork`. A runtime clone count is not knowable from a static description — stay on those three shapes. Leave `clonable` and `clone_forks` unset.

A review, approval, or sign-off step is a gated stage: put `gate_kinds` on that stage file and follow [`stage-prompt-template.md`](stage-prompt-template.md).

## Worked examples

### Review loop (linear)

Three sequential steps; the middle one is a sign-off.

```yaml
id: review-loop
stages:
  - id: draft
    uses: ./draft.yaml
  - id: review
    uses: ./review.yaml
    needs: draft
  - id: publish
    uses: ./publish.yaml
    needs: review
```

`review` carries `gate_kinds: [artifact_backed]`. Full set: [`../assets/examples/linear-review/`](../assets/examples/linear-review/).

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
    needs: run-tests
  - id: ship
    uses: ./ship.yaml
    needs: run-tests
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
    needs: gather
  - id: send
    uses: ./send.yaml
    needs: summarize
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
    needs: intake
  - id: collect-notes
    uses: ./collect-notes.yaml
    needs: intake
```

No `fork` field. Both siblings run.

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
    needs: choose-channels
  - id: post
    uses: ./post.yaml
    needs: choose-channels
```

The success emit names one or more of those successor ids in `fork_choice`.
