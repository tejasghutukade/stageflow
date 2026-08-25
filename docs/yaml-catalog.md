---
layout: default
title: Yaml Catalog
---

# YAML catalog

Stageflow reads a **project-local catalog** — no hosted config service. Three directories define what can run:

| Directory | Purpose |
|-----------|---------|
| `pipelines/` | Ordered or DAG-linked lists of stage ids |
| `stages/` | Pi agent config per stage (prompt, model, gates, schema) |
| `tasks/` | Per-run input (goal, context, optional checkout) |

**Stages are author-defined.** Stageflow validates shape and wiring; it does not ship domain-specific stage types. A `research` stage and a `release-draft` stage are the same mechanism — different YAML you write.

Canonical examples: [`tests/fixtures/`](../tests/fixtures/).

## Layout

```
my-project/
  pipelines/
    hello.yaml
  stages/
    research.yaml
  tasks/
    my-task.yaml
  .stageflow/          # runtime state (created on first run)
```

## Pipelines (`pipelines/*.yaml`)

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Pipeline identifier; should match filename stem |
| `stages` | array | Non-empty list of stage ids or stage refs |

### Linear pipelines

List stage ids as **strings** for a simple chain — each entry implicitly `needs` the previous one (except the first):

```yaml
id: single
stages:
  - clarify
```

For a multi-stage string chain, list ids in order; the runtime wires `needs` from array position.

See [`tests/fixtures/pipelines/single.yaml`](../tests/fixtures/pipelines/single.yaml).

### Explicit dependencies (`needs`)

Use **object entries** (`id` + optional `needs`) for parallel branches or explicit deps. Object entries without `needs` are **roots** (no implicit previous-stage dependency):

```yaml
stages:
  - id: clarify          # root — needs: null
  - id: design-doc
    needs: clarify
```

Explicit linear example:

```yaml
id: linear-explicit
stages:
  - id: clarify
  - id: design-doc
    needs: clarify
  - id: implementation-plan
    needs: design-doc
```

See [`tests/fixtures/pipelines/linear-explicit.yaml`](../tests/fixtures/pipelines/linear-explicit.yaml).

### Parallel fan-out

Multiple stages with the same `needs` run in parallel after the dependency completes:

```yaml
id: parallel-five-fork
stages:
  - id: clarify
  - id: parallel-branch-a
    needs: clarify
  - id: parallel-branch-b
    needs: clarify
```

See [`tests/fixtures/pipelines/parallel-five-fork.yaml`](../tests/fixtures/pipelines/parallel-five-fork.yaml).

**Constraints:**

- `needs` must reference a **single** stage id (fan-in from multiple parents is not supported)
- Stage ids must exist as files under `stages/`
- The DAG must be acyclic

Resolve pipeline by id (`hello`) or path (`pipelines/hello.yaml`).

## Stages (`stages/*.yaml`)

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stage id; **must match filename** (`research.yaml` → `id: research`) |
| `system_prompt` | string | Instructions for the Pi agent in this stage |
| `model` | string | Provider/model id (e.g. `anthropic/claude-sonnet-4-5`) |

Optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `gate_kinds` | string[] | Declared HITL kinds this stage may use — see [HITL](hitl.md) |
| `payload_schema` | object | JSON Schema subset for `envelope.payload` on success |
| `skill` | string | Pi skill name to attach for this stage |

Example minimal stage:

```yaml
id: clarify
system_prompt: Clarify the task into crisp requirements.
model: anthropic/claude-sonnet-4-5
```

Example with operator gate declaration:

```yaml
id: plan-review
gate_kinds:
  - artifact_backed
system_prompt: |
  Produce a plan artifact, get operator acceptance, then emit envelope.
model: anthropic/claude-sonnet-4-5
```

See [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

Allowed `gate_kinds` values: `free_text`, `confirm`, `multi_question`, `artifact_backed`.

## Tasks (`tasks/*.yaml`)

Tasks are **run input**, not part of the static catalog validation scope.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Task identifier |
| `goal` | string | yes | What the pipeline should accomplish |
| `context` | string | no | Background for all stages |
| `constraints` | string | no | Boundaries (e.g. docs-only) |
| `checkout` | string | no | Path to a working tree for code tasks |

Example:

```yaml
id: sample
goal: Design a calendar web app
context: Personal productivity prototype
constraints: Docs only; no implementation code
```

See [`tests/fixtures/tasks/sample.yaml`](../tests/fixtures/tasks/sample.yaml).

Pass a task file to `sf run --task` or inline a task object via MCP `start_run`.

## Validation

```bash
sf validate                  # full catalog
sf validate --pipeline hello # single pipeline
sf validate --strict         # orphan stages → errors
sf validate --json
```

Checks: pipeline shape, DAG, stage files, id/filename match, payload schema compile, gate kind strings, duplicate pipeline ids.

Does **not** check: task files, provider auth, checkout existence.

Finding codes include `pipeline.dag_error`, `pipeline.missing_stage`, `stage.id_filename_mismatch`, `catalog.orphan_stage`, and others — see `src/config/validateCatalog.ts`.

## Runtime behavior (summary)

1. Load pipeline + referenced stages
2. Schedule stages per DAG (parallel when deps allow)
3. Each stage: fresh Pi session, tools `write_stage_artifact`, `ask_operator`, `emit_stage_envelope`
4. Pipeline advances only after a **success** envelope — see [Envelopes](envelopes.md)

## See also

- [Quick start](quickstart.md) — minimal end-to-end project
- [Envelopes](envelopes.md) — handoff contract between stages
- [HITL](hitl.md) — operator gates and `gate_kinds`
- [CLI reference](cli-reference.md) — `sf validate` flags
