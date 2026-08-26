# hello-world

Minimal single-stage pipeline. Domain-neutral — the stage id and prompts are yours to define.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`)
- A Pi-compatible provider connected via `sf ui` or `sf providers login`

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/hello-world/hello.pipeline.yaml --strict
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Use `sf ui` (from any subdirectory) to watch the run and inspect the stage envelope.
