---
layout: default
title: Yaml Catalog
---

# YAML catalog

Stageflow uses a **pipeline-owned catalog**: each pipeline file lists stages as object entries with `uses:` (external YAML) or an inline body. Tasks are separate `*.task.yaml` files. A repo-root **`stageflow.yaml`** manifest declares which directories the operator console browses.

Canonical fixtures: [`tests/fixtures/pipelines/`](../tests/fixtures/pipelines/), [`tests/fixtures/stages/`](../tests/fixtures/stages/), [`tests/fixtures/tasks/`](../tests/fixtures/tasks/).

## Layout

```
my-project/
  stageflow.yaml
  pipelines/
    hello.pipeline.yaml       # inline or uses: stage entries
  tasks/
    hello.task.yaml
  .stageflow/                 # runtime state at git root
```

**Flat layout** — pipeline and task files may also live at the repo root (e.g. `hello.pipeline.yaml`, `my-task.task.yaml`) beside `stageflow.yaml`; validation and CLI accept any filesystem path. This repo uses a flat root for some pipelines under `tests/fixtures/`.

Runnable examples live under [`examples/`](../examples/). This repo's manifest is [`stageflow.yaml`](../stageflow.yaml) (examples only; `tests/fixtures` excluded from browse).

## Filename patterns

| Kind | Pattern | Example |
|------|---------|---------|
| Pipeline | `*.pipeline.yaml` | `hello.pipeline.yaml` |
| Task | `*.task.yaml` | `my-task.task.yaml` |
| Stage (external) | any `*.yaml` beside pipeline or under shared pool | `research.yaml`, `../stages/clarify.yaml` |

CLI **`--pipeline` and `--task` require filesystem paths** — there is no bare-id fallback.

## Pipelines (`*.pipeline.yaml`)

Required top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Pipeline identifier (should match filename stem) |
| `stages` | array | Non-empty list of **object** stage entries |

Bare string stage refs are rejected.

### Stage entries

Each stage is an object with `id` and one of:

| Form | Fields | Use when |
|------|--------|----------|
| External | `uses: <path>` | Stage body lives in another YAML file |
| Inline | `system_prompt`, `model`, … | Single-file pipeline |

Optional on any entry: `needs`, `fork`, `gate_kinds`, `payload_schema`, `skill`.

**`uses:` paths are relative to the pipeline file's directory.**

Linear chain with external stages:

```yaml
id: linear-explicit
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
  - id: design-doc
    uses: ../stages/design-doc.yaml
    needs: clarify
  - id: implementation-plan
    uses: ../stages/implementation-plan.yaml
    needs: design-doc
```

See [`tests/fixtures/pipelines/linear-explicit.pipeline.yaml`](../tests/fixtures/pipelines/linear-explicit.pipeline.yaml).

Inline single stage:

```yaml
id: hello
stages:
  - id: research
    system_prompt: Summarize the task goal.
    model: anthropic/claude-sonnet-4-5
```

Parallel fan-out: multiple stages with the same `needs` (siblings):

```yaml
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
  - id: design-doc
    uses: ../stages/design-doc.yaml
    needs: clarify
  - id: implementation-plan
    uses: ../stages/implementation-plan.yaml
    needs: clarify
```

See [`tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml`](../tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml).

### Pipeline fragments (`include:`)

At the **pipeline top level** (not inside a stage entry), merge stage lists from fragment files:

```yaml
id: include-merge
include:
  - local: ./fragments/gates.yaml
stages:
  - id: finish
    uses: ./finish.yaml
    needs: gate
```

Fragment files contain a `stages:` array (same entry shapes as the parent pipeline). Paths in `local:` are relative to the pipeline file's directory.

Fixture: [`tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml`](../tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml).

### Fork pipelines

A deciding stage may declare a `fork` object to require a runtime choice among its immediate successors. The stage must emit `fork_choice` in its envelope (see [Envelopes](envelopes.md)). Use **object-form** stage entries (`id:` + optional `uses:` + `fork:`) — bare string stage refs cannot carry `fork`.

| Field | Required | Description |
|-------|----------|-------------|
| `select` | yes | `one` — exactly one immediate successor must be named in `fork_choice`. `subset` — one or more successors (including all, some, or none when `allow_none` is set). |
| `allow_none` | no | Boolean, default `false`. When `true`, an empty `fork_choice: []` is valid and all immediate successors are skipped. |

Children list `needs: <parent>`. A stage with multiple children and **no** `fork` field is [parallel fan-out](#parallel-fan-out-multiple-stages-with-the-same-needs-siblings) — every successor runs. A stage with `fork` requires the completing agent to name which successors run via `fork_choice`. Requiring `fork_choice` from a plain fan-out stage would break existing pipelines; omitting it from a fork stage fails emit validation.

Unchosen branches are marked `skipped`, including **all downstream descendants** of the unchosen stage — not only the immediate successor. In [`fork-route-cascade.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml), when `clarify` emits `fork_choice: ["design-doc"]`, both `implementation-plan` and `join-doc` are skipped because `join-doc` depends on the unchosen branch.

Skipped stages appear on every observable surface with the same `skipped` status used when a parent fails: operator console run timeline, CLI stage output, MCP `get_run`, and JSON run records. Unchosen fork branches are not failures; see [CI / headless](ci.md) for exit-code behavior.

`fork` on a stage with no immediate successors (a DAG leaf) fails validation (`pipeline.dag_error`). Pipelines without `fork` are unaffected.

```yaml
id: fork-demo
stages:
  - id: decide
    uses: ./decide.yaml
    fork:
      select: one
  - id: branch-a
    uses: ./branch-a.yaml
    needs: decide
  - id: branch-b
    uses: ./branch-b.yaml
    needs: decide
```

Fixtures:

- [`fork-one-of-two.pipeline.yaml`](../tests/fixtures/pipelines/fork-one-of-two.pipeline.yaml) — exclusive `select: one`
- [`fork-route-cascade.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml) — cascade skip through descendants
- [`fork-route-subset.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-subset.pipeline.yaml) — `select: subset`, multiple successors allowed
- [`fork-route-allow-none.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-allow-none.pipeline.yaml) — `allow_none: true`, empty choice valid

Walkthrough: [`examples/conditional-fork/`](../examples/conditional-fork/).

## External stage files

Stage YAML (referenced via `uses:`) requires:

| Field | Description |
|-------|-------------|
| `id` | Must match pipeline entry `id` |
| `system_prompt` | Agent instructions |
| `model` | Provider/model string |

Optional: `gate_kinds`, `payload_schema`, `skill`.

Shared pool example: [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

## Tasks (`*.task.yaml`)

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Task identifier |
| `goal` | yes | What the run should accomplish |
| `context` | no | Background for agents |
| `constraints` | no | Boundaries |
| `checkout` | no | Relative or absolute path to working tree |

See [`tests/fixtures/tasks/sample.task.yaml`](../tests/fixtures/tasks/sample.task.yaml).

## Manifest (`stageflow.yaml`)

Declares catalog roots for **`sf validate`** (manifest-all) and operator-console browse.

```yaml
version: 1
catalog:
  pipelines:
    - examples/hello-world
    - examples/plan-review
  tasks:
    - examples/hello-world
    - examples/plan-review
  patterns:
    pipeline: "*.pipeline.yaml"
    task: "*.task.yaml"
  exclude:
    - tests/fixtures
```

- **`exclude`**: paths omitted from console browse (fixtures may still be loaded by explicit CLI path in tests).
- **`patterns`**: glob for directory scans (defaults shown above).

Scaffold a new project: **`sf init`** creates `stageflow.yaml`, `pipelines/` (with an inline stage in `hello.pipeline.yaml`), and `tasks/` — not a global `stages/` pool.

## Validation

```bash
sf validate --strict                    # manifest-all from git root
sf validate --pipeline path/to/x.pipeline.yaml --strict
sf validate --task path/to/x.task.yaml --strict
```

Validation checks pipeline shape, `uses:` resolution, DAG (`needs`, cycles), and stage file shape. It does not verify provider credentials or checkout paths.

## CLI run

```bash
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Run state is stored under **`<git-root>/.stageflow/`** regardless of which subdirectory you start `sf ui` from.
