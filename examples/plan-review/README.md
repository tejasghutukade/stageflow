# plan-review

Two-stage pipeline with an **artifact-backed operator gate** (`ask_operator`). This is an **SDLC-style example** — plan review before implementation — but the same HITL pattern applies to any workflow you author.

Fixture twin: `tests/fixtures/pipelines/plan-review-proving.pipeline.yaml`.

## Prerequisites

- Node.js ≥ 20, Stageflow installed
- Provider auth connected
- Operator console: `sf ui` (default `http://127.0.0.1:3847`)

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/plan-review/plan-review.pipeline.yaml --strict
```

Terminal 1:

```bash
sf ui
```

Terminal 2:

```bash
sf run \
  --pipeline examples/plan-review/plan-review.pipeline.yaml \
  --task examples/plan-review/plan-review.task.yaml
```

When the first stage blocks on HITL, open the run in the console, review the plan artifact, and accept or reject. Exit code `2` means waiting on operator input.

See [docs/hitl.md](../../docs/hitl.md).
