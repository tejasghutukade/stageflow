# hello-world

Minimal single-stage pipeline. Domain-neutral — the stage id and prompts are yours to define.

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`)
- A Pi-compatible provider (Anthropic, OpenAI, etc.) connected via `sf ui` or `sf providers login`

## Commands

From this directory:

```bash
sf validate --strict
sf run --task tasks/my-task.yaml --pipeline hello
```

Use `sf ui` to watch the run and inspect the stage envelope.
