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

Each stage is an object with one of:

| Form | Fields | Use when |
|------|--------|----------|
| External | `uses: <path>` | Stage body lives in another YAML file |
| Inline | `system_prompt`, `model`, … | Single-file pipeline |

`id` may be omitted when it is inferable from the `uses:` basename (`*.yaml` or `*.stage.yaml`).

**Wiring** (any entry, including `uses:`): `needs`, `fork`, `clonable`, `clone_cap`, `skill`, `completion`, `recovery`.

**Body** (inline entry or external stage file): `system_prompt`, `model`, `gate_kinds`, `payload_schema`. The JSON Schema subset for `payload_schema` is in [Envelopes](envelopes.md#payload-schema).

`uses:` plus any body key except `skill` is rejected (`pipeline.stage_uses_inline_conflict`). `skill` may sit on the `uses:` wrapper.

`completion` and `recovery` are pipeline-stage execution policy. They may sit beside
`uses:` because a reusable stage can require different proof or recovery behavior in
different pipelines. See [Verified Stage Execution](verified-stage-execution.md) for
the fixed Slice 1 check types and schema.

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

`needs` is a single stage id (string), not an array. Fan-in and diamond DAGs are unsupported. Parallel fan-out is multiple children with the same parent, not multiple parents.

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

Nested `include:` is allowed. Cycles and duplicate stage ids across files are rejected. Includes merge before the declaring file's own `stages`.

Fixture: [`tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml`](../tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml).

### Fork pipelines

A deciding stage may declare a `fork` object to require a runtime choice among its immediate successors. The stage must emit `fork_choice` in its envelope (see [Envelopes](envelopes.md)). Use **object-form** stage entries (`id:` + optional `uses:` + `fork:`) — bare string stage refs cannot carry `fork`.

| Field | Required | Description |
|-------|----------|-------------|
| `select` | yes | `one` — exactly one immediate successor must be named in `fork_choice`. `subset` — one or more successors (including all, some, or none when `allow_none` is set). |
| `allow_none` | no | Boolean, default `false`. Only usable with `select: subset`. When `true`, an empty `fork_choice: []` is valid and all immediate successors are skipped. |

`fork` accepts only `select` and `allow_none`. Catalog validation does not reject `select: one` together with `allow_none: true`; emit still requires exactly one choice — empty `fork_choice` fails even if `allow_none` is set.

`fork_choice` names only non-clonable immediate successors. When every child is clonable, `fork_choice` is not required.

Children list `needs: <parent>`. A stage with multiple children and **no** `fork` field is [parallel fan-out](#parallel-fan-out-multiple-stages-with-the-same-needs-siblings) — every successor runs. A stage with `fork` requires the completing agent to name which successors run via `fork_choice`. Requiring `fork_choice` from a plain fan-out stage would break existing pipelines; omitting it from a fork stage fails emit validation.

Unchosen branches are marked `skipped`, including **all downstream descendants** of the unchosen stage — not only the immediate successor. In [`fork-route-cascade.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml), when `clarify` emits `fork_choice: ["design-doc"]`, both `implementation-plan` and `join-doc` are skipped because `join-doc` depends on the unchosen branch.

Skipped stages appear on every observable surface with the same `skipped` status used when a parent fails: operator console spatial map / run detail, CLI stage output, MCP `get_run`, and JSON run records. Unchosen fork branches are not failures; see [CI / headless](ci.md) for exit-code behavior.

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

### Clonable successors {#clonable-successors}

A successor object entry may set `clonable: true`. The completing predecessor must then emit `clone_forks` for that successor (see [Envelopes](envelopes.md#clonable-successors)). Optional `clone_cap` is an integer; omit the field to take the default 5. When `clone_cap` is set, it must be an integer ≥ 2 — setting `1` is a catalog validation error. Bare string refs cannot carry `clonable`. Over-cap fails the predecessor. `clonable: true` on a DAG leaf fails catalog validation — a clonable successor must have at least one child (typically a join).

```yaml
id: clonable-demo
stages:
  - id: detect-changes
    uses: ./detect-changes.yaml
  - id: author-diagrams
    uses: ./author-diagrams.yaml
    needs: detect-changes
    clonable: true
    clone_cap: 5
  - id: collect
    uses: ./collect.yaml
    needs: author-diagrams
```

A clone may skip, run once, or fan out its own successor only when that successor is also `clonable`. See [`clonable-nested-gate.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-gate.pipeline.yaml) and [`examples/clonable-fanout/`](../examples/clonable-fanout/). v1 does not support two clones both fanning out the same successor.

A clonable successor is not selected via `fork_choice`. `clone_forks` is the only include/skip/N control for that successor. `fork_choice` ids are non-clonable immediate successors; when every child is clonable, `fork_choice` is not required. Named siblings still use `fork_choice` when the parent has `fork`. See [`clone-fanout-mix.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-mix.pipeline.yaml) (`fork.select: subset` plus clonable `design-doc` and named `implementation-plan`).

#### Instance ids {#clonable-instance-ids}

Run-once keeps the catalog id. Fan-out mints `{catalogId}~{n}` with 1-based `n` in the predecessor's clone-list order. YAML `needs` stays the catalog id. Instance ids must not contain `/`, `\`, or `..`. The operator console labels clones `definition · N` (see [Operator console](operator-console.md#clone-tracks)); disk paths and API keys stay the raw instance id.

Join requires every clone to succeed in both modes. When the join runs, `priorEnvelopes` are success-only (0.7; 0.5 included failures). Sequential also skips remaining clones on first failure; parallel lets sibling clones finish. Details: [envelopes](envelopes.md#clonable-successors).

Fixtures:

- [`clonable-default-cap.pipeline.yaml`](../tests/fixtures/pipelines/clonable-default-cap.pipeline.yaml) — `clonable: true` with default cap 5
- [`clone-fanout-join.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-join.pipeline.yaml) — fan-out then join
- [`clone-fanout-mix.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-mix.pipeline.yaml) — mix with named sibling + fork
- [`clonable-nested-gate.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-gate.pipeline.yaml) — clone toward a non-clonable collect
- [`clonable-nested-fanout.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-fanout.pipeline.yaml) — clonable successor of a clone, then a non-clonable join

Walkthrough: [`examples/clonable-fanout/`](../examples/clonable-fanout/).

Rewire of [`examples/archify-on-pr`](../examples/archify-on-pr/) is deferred; that example remains a single `author-diagrams` session until a later change.

### Skill binding {#skill-binding}

Bind a Pi skill to a stage on the **pipeline stage entry** (alongside `uses:` or inline body). The loader also accepts `skill:` in external stage files; a pipeline-entry `skill` overrides the file value on merge. Prefer the pipeline entry.

```yaml
stages:
  - id: author-diagrams
    uses: ./author-diagrams.yaml
    needs: detect-changes
    skill: archify
```

| Behavior | Detail |
|----------|--------|
| Resolution | Looks up `.pi/skills/<name>/SKILL.md` under the operator checkout (`--operator-cwd` / `STAGEFLOW_OPERATOR_CWD`) and the Pi agent skills dir |
| Startup | Stage fails before the agent session if the skill is not installed |
| Agent prompt | Skill instructions are injected for the stage attempt |

Install skills before `sf run` in CI:

```bash
sf skills install --from-zip <url> --skill-name archify
```

Walkthrough: [`examples/archify-on-pr/`](../examples/archify-on-pr/) — GHA provisions Archify, agents author JSON specs only; shell steps run `deliver` outside the agent.

## External stage files

Stage YAML (referenced via `uses:`) requires:

| Field | Description |
|-------|-------------|
| `id` | Must match the pipeline entry `id` and the filename stem (`sf validate`) |
| `system_prompt` | Agent instructions |
| `model` | Provider/model string |

Optional body fields on the file (not on the `uses:` wrapper): `gate_kinds`, `payload_schema` — see [Envelopes](envelopes.md#payload-schema). The loader accepts `skill:` here; prefer binding it on the pipeline entry (see [Skill binding](#skill-binding)).

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
sf validate --strict                    # manifest-all: pipelines, stages, and tasks from git root
sf validate --pipeline path/to/x.pipeline.yaml --strict   # that pipeline and its stages
sf validate --task path/to/x.task.yaml --strict           # that task
```

Validation checks pipeline shape, `uses:` resolution, DAG (`needs`, cycles), stage file shape, and task shape. It does not verify provider credentials or checkout paths.

## CLI run

```bash
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Run state is stored under **`<git-root>/.stageflow/`** regardless of which subdirectory you start `sf ui` from.
