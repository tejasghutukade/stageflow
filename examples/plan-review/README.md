# plan-review

Two-stage pipeline with an **artifact-backed operator gate** (`ask_operator`). This is an **SDLC-style example** — plan review before implementation — but the same HITL pattern applies to any workflow you author.

Adapted from `tests/fixtures/pipelines/plan-review-proving.yaml`.

## Prerequisites

- Node.js ≥ 20, Stageflow installed
- Provider auth connected
- Operator console for the gate: run `sf ui` in a separate terminal (default `http://127.0.0.1:3847`)

## Commands

From this directory:

```bash
sf validate --strict
sf ui
```

In another terminal:

```bash
sf run --task tasks/plan-review.yaml --pipeline plan-review
```

When the first stage blocks on HITL, open the run in the console, review the plan artifact, and accept or reject. Exit code `2` means waiting on operator input.

See [docs/hitl.md](../../docs/hitl.md).
