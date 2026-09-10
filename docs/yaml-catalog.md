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
  .mcp.json                   # optional project MCP catalog
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

Optional top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Pipeline default LLM/provider id for stages that omit their own `model` (see [Model defaults and precedence](#model-defaults-and-precedence)) |
| `agent` | string | Pipeline default execution backend (`pi` or Claude-family). Backend selection is separate from `model`; see [Architecture](architecture.md) |
| `schemas` | object | Named JSON Schema map for `$ref: "#/schemas/<name>"` on stage `io` (see [Pipeline schemas](#pipeline-schemas)) |

Bare string stage refs are rejected.

### Stage entries

Each stage is an object with one of:

| Form | Fields | Use when |
|------|--------|----------|
| External | `uses: <path>` | Stage body lives in another YAML file |
| Inline | `system_prompt`, optional `model`, … | Single-file pipeline |

`id` may be omitted when it is inferable from the `uses:` basename (`*.yaml` or `*.stage.yaml`).

**Wiring** (any entry, including `uses:`): `needs`, `fork`, `uses`, `clonable`, `clone_cap`, `on_verify_fail`, `feedback_loop`, `replay_safe`. `skill` and `mcp` may sit on a `uses:` wrapper or on the body — see [Skill binding](#skill-binding) and [Stage MCP](#stage-mcp).

**Body** (inline entry or external stage file): `system_prompt` (required), `model` (**optional** when a pipeline or manifest default supplies it), `io`, `verify`, `gate_kinds`, `skill`, `mcp`, `timeout_ms`, `clone_actions`. Effective `model` is materialized at pipeline load — see [Model defaults and precedence](#model-defaults-and-precedence). `io.output.schema` is the producer contract for success `payload`; `io.input.schema` is what the stage requires to start (clone assignment is the strong case). JSON Schema subset: [Envelopes — io schemas](envelopes.md#io-schemas). Presence of `io.output.schema` still implies emit-time payload validation on success. `verify` is one list of checks with `when: [emit]`, `[after]`, or both — see [Verify](#verify). Optional parent `clone_actions` is a non-empty list of `skip` | `once` | `fanout`; omit the field to keep all three. See [Envelopes — clonable successors](envelopes.md#clonable-successors). Optional `timeout_ms` is a positive integer wall-clock budget for the stage attempt in milliseconds (default 3600000 / 60 minutes when omitted).

`uses:` plus any body key except `skill` and `mcp` is rejected (`pipeline.stage_uses_inline_conflict`). `skill` and `mcp` may sit on the `uses:` wrapper.

`on_verify_fail` is pipeline-stage wiring. It may sit beside `uses:` because a reusable stage can recover differently in different pipelines. `verify` belongs on the body (the `uses:` target or the inline entry), not on the wrapper.

### Dual-read (this release)

**Author** `io` / `verify` / `on_verify_fail`. This release still **loads** catalogs that use the previous field names (left column). Convert them with [`sf migrate-yaml`](cli-reference.md#sf-migrate-yaml) (dry-run default; `--write` to apply). Mixed old and new contract keys in one file fail load. Do not author both spellings. **New catalog fields belong in the Author YAML column** — compile them in `src/config/yamlDialect.ts`. Runtime, snapshots, emit, and VSE keep the Runtime IR names as TypeScript/JSON.

Dual-read is the load adapter for those previous names (on by default). Turn it off with `STAGEFLOW_LEGACY_YAML=0` (rejects legacy authoring keys; `sf migrate-yaml` still reads legacy). Dropping dual-read later is deleting [`src/config/legacyYaml.ts`](../src/config/legacyYaml.ts) plus the migrator — not renaming runtime IR (`payload_schema` / `pre_emit_checks` / `completion` / `recovery`).

| Runtime IR (dual-read YAML) | Author YAML |
|-----------------------------|-------------|
| `payload_schema` | `io.output.schema` |
| `clone_input_schema` | `io.input.schema` |
| `pre_emit_checks` | `verify` (when includes `emit`) |
| `completion` | `verify` (when includes `after`) |
| `recovery` | `on_verify_fail` |
| `artifact_declared` | `type: artifact` + `emit` |

### Model defaults and precedence

`model` is an LLM/provider id string. It is distinct from `agent`, which selects the execution backend (Pi vs Claude SDK). The two hierarchies share the same tier *shape* but use separate keys — this model hierarchy is separate from `agent`.

Effective model for each stage is materialized at **pipeline load** (not at stage runtime):

```text
stage.model ?? pipeline.model ?? stageflow.yaml model
```

| Tier | Source | Wins when |
|------|--------|-----------|
| Stage | Inline body or external stage YAML | Stage sets `model` |
| Pipeline | Top-level `model` on the **root** `*.pipeline.yaml` | Stage omits `model` |
| Global | Top-level `model` on `stageflow.yaml` | Stage and pipeline omit `model` |

Pipeline `model` is read only from the **root** pipeline file (the path passed to load/validate). Top-level `model` on [included fragments](#pipeline-fragments-include) is ignored — same pattern as pipeline `agent`. When that root `model` fills one or more stages that omit `model`, `sf validate` emits warning `pipeline.model_applies` (not an error; `--strict` does not promote it).

Global tier: **absence** of `stageflow.yaml` means no global default. A **present but invalid** `stageflow.yaml` (bad shape, empty `model`, etc.) fails pipeline load with catalog/manifest errors — it is not treated as “no global.”

If the chain still leaves `model` unset, pipeline load **fails with a clear error**. There is **no** silent hardcoded model string (unlike backend selection, which falls back to `"pi"`).

Canonical fixtures:

| Case | Path |
|------|------|
| Manifest-only fill | [`tests/fixtures/model-hierarchy/global-default/`](../tests/fixtures/model-hierarchy/global-default/) |
| Pipeline-only fill | [`tests/fixtures/model-hierarchy/pipeline-default/`](../tests/fixtures/model-hierarchy/pipeline-default/) |
| Stage overrides pipeline and global | [`tests/fixtures/model-hierarchy/stage-override/`](../tests/fixtures/model-hierarchy/stage-override/) |
| All three tiers empty (must fail) | [`tests/fixtures/model-hierarchy/missing-all/`](../tests/fixtures/model-hierarchy/missing-all/) |

### Verify {#verify}

`verify` is a body list of checks. Written `when` is `[emit]`, `[after]`, or both. Omitted `when` is allowed except on `type: artifact`, which must set `when` explicitly.

| Default when `when` is omitted | Types |
| --- | --- |
| `[emit]` | `gate` |
| `[after]` | `command`, `checkout_changes`, `checklist`, `payload_schema` (the check type) |

Emit-phase checks run in-session during `emit_stage_envelope` (soft reject: `isError`, no `terminate`). After-phase checks are Verified Stage Execution — hard proof after a candidate envelope is captured. See [Envelopes — emit-phase verify](envelopes.md#verify-emit) and [Verified Stage Execution](verified-stage-execution.md).

```yaml
verify:
  - id: plan-accepted
    type: gate
    kind: artifact_backed
  - id: plan-declared
    type: artifact
    basename: plan.md
    when: [emit]
  - id: plan-on-disk
    type: artifact
    path: plan.md
    nonempty: true
    when: [after]
  - id: tests
    type: command
    run: npm test
```

Check discriminator is `type:` (not `kind:`). Gate widgets still use `kind:` on `type: gate`.

| Check type | Required fields | Optional fields | Legal `when` |
| --- | --- | --- | --- |
| `gate` | `id`, `kind` | — | `emit` (default), `after`, or both |
| `artifact` | `id`, `when` | `basename` (emit), `path` / `nonempty` (after) | `emit`, `after`, or both — **required** |
| `command` | `id`, `run` | `cwd`, `timeout_ms` | `after` only |
| `checklist` | `id`, `items` | — | `after` only |
| `payload_schema` | `id` | — | `after` only; requires `io.output.schema` |
| `checkout_changes` | `id` | `path_fields` | `after` only |

Check IDs are unique within the stage. `artifact.path` is relative to the stage attempt's artifact directory. Emit `type: artifact` is a basename list check on `envelope.artifacts` (no disk I/O). After `type: artifact` is an on-disk file under the attempt artifacts dir. `gate.kind` must also appear in the stage's `gate_kinds`. Each `checkout_changes.path_fields` entry must name a required array-of-strings field in `io.output.schema`. Optional `type: payload_schema` with `when: [after]` re-checks the captured payload against `io.output.schema`; emit-time payload validation already runs when that schema is present.

### `on_verify_fail` {#on-verify-fail}

`on_verify_fail` is wiring and applies only after an **after-phase** verify failure. It requires at least one after-phase `verify` item on the resolved stage.

| Mode | Required fields | Behavior |
| --- | --- | --- |
| `repair` | `max_attempts`, `retry_safety: idempotent`, `include_failed_checks` | Stageflow starts fresh attempts until the limit, carrying failed-check evidence when configured. |
| `manual` | `retry_safety` | An operator explicitly starts a new attempt with optional guidance or stops recovery for that run. |

Use `manual` for side-effecting work such as publishing or payments. Operator commands keep their names: [`sf runs recover`](cli-reference.md#sf-runs-recover) / [`sf runs verify`](cli-reference.md#sf-runs-verify), MCP [`recover_manual_stage`](mcp.md#recover_manual_stage), HTTP `/api/runs/:id/stages/:id/recovery`. See [Verified Stage Execution](verified-stage-execution.md).

### Pipeline schemas {#pipeline-schemas}

Optional pipeline-file `schemas:` is the `$ref` root for this release. Refs are JSON Pointer `#/schemas/<name>`. Cycles fail load. `schemas:` on an include fragment fails load. Isolated stage validate of a `$ref`-only schema fails with `stage.unresolved_schema_ref`; pipeline validate resolves after attach.

Sequential single-parent non-clone edges: if both sides have schemas, consumer `io.input` must be a structural subset of producer `io.output`. Clone edges and multi-parent joins do not run that subset check — the child's `io.input` is the assignment or join contract.

```yaml
id: story-handoff
model: anthropic/claude-sonnet-4-5
schemas:
  story-slice:
    type: object
    required: [title]
    properties:
      title:
        type: string
stages:
  - id: draft
    system_prompt: Draft the slice and emit a success envelope.
    io:
      output:
        schema:
          $ref: "#/schemas/story-slice"
  - id: review
    system_prompt: Review the slice.
    needs: [draft]
    io:
      input:
        schema:
          $ref: "#/schemas/story-slice"
```

Runnable demo with `uses:` stages: [`examples/feature-loop/`](../examples/feature-loop/) (`schemas.story-assignment` → `plan` `io.input.schema`).

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

Inline single stage (explicit stage `model`):

```yaml
id: hello
stages:
  - id: research
    system_prompt: Summarize the task goal.
    model: anthropic/claude-sonnet-4-5
```

Pipeline-level `model` with omitted stage `model` (filled from the pipeline default):

```yaml
id: hello
model: anthropic/claude-sonnet-4-5
stages:
  - id: research
    system_prompt: Summarize the task goal.
```

See also [`tests/fixtures/model-hierarchy/pipeline-default/`](../tests/fixtures/model-hierarchy/pipeline-default/).

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

`needs` is either a single parent stage id (string) or a non-empty array (length ≥ 1). A one-item array is the same graph as a scalar. Parallel fan-out is multiple children with the same parent. Keyed generic fan-in is one child with a `needs` array of two or more parents — see [Generic fan-in](#generic-fan-in). Clone-list joins still use a single catalog parent id — see [Clonable successors](#clonable-successors).

### Generic fan-in {#generic-fan-in}

A stage may wait for two or more catalog parents. `needs` takes one of two forms:

| Form | Shape | When |
|------|-------|------|
| Scalar | `needs: <stage-id>` | One parent. The accepted terminal is `succeeded` only. |
| Array | `needs: [ … ]` with length ≥ 1 | One or more parents. Length 1 is the same graph as a scalar. Length ≥ 2 is keyed generic fan-in. |

Array items may be mixed. A string id defaults to `on: [succeeded]`. `{ id, on }` declares a non-empty unique subset of `succeeded` \| `failed` \| `skipped`. Duplicate ids, unknown keys, unknown parents, empty `on`, and cycles are rejected.

```yaml
id: diamond-fan-in
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
  - id: research
    uses: ../stages/research.yaml
    needs: clarify
  - id: validation
    uses: ../stages/validation.yaml
    needs: clarify
  - id: synthesize
    uses: ../stages/synthesize.yaml
    needs:
      - research
      - validation
```

Structured `on` sets (accepted failure or skip):

```yaml
  - id: synthesize
    uses: ../stages/synthesize.yaml
    needs:
      - id: research
        on: [succeeded, failed, skipped]
      - id: validation
        on: [succeeded]
```

The join starts only after every declared parent (or every current clone instance of a clonable parent) is terminal in that parent's accepted set. Join input is `priorEnvelopesByStage`, keyed in YAML declaration order. `priorEnvelope` is `null`. Do not reuse clone-list `priorEnvelopes` — that field stays for [clone-list joins](#clonable-successors). A clonable parent under generic fan-in maps to one key whose value is that parent's clone-list-ordered envelope array (or `[]` when a skip of the definition is accepted). See [Envelopes](envelopes.md#downstream-consumption). Walkthrough: [`examples/generic-fan-in/`](../examples/generic-fan-in/).

A parent whose observed terminal is not in that edge's `on` set skips only incompatible paths. Independent siblings and joins that accept the observed state continue. Accepted failed or skipped parents stay visibly terminal and do not independently fail the run.

Fixtures:

- [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml) — static diamond, string `needs` array
- [`diamond-fan-in-accepted.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in-accepted.pipeline.yaml) — structured `on` including failed and skipped
- [`diamond-fan-in-clone.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in-clone.pipeline.yaml) — clonable parent plus named sibling join

Runtime coverage: [`tests/runtime.genericFanIn.schedule.test.ts`](../tests/runtime.genericFanIn.schedule.test.ts), [`tests/runtime.genericFanIn.retry.test.ts`](../tests/runtime.genericFanIn.retry.test.ts), [`tests/runtime.envelopeRouting.test.ts`](../tests/runtime.envelopeRouting.test.ts), [`tests/runstore.trackProjection.test.ts`](../tests/runstore.trackProjection.test.ts).

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

Fragment files contain a `stages:` array (same entry shapes as the parent pipeline). Paths in `local:` are relative to the pipeline file's directory. Top-level `model` / `agent` on a fragment are ignored; only the root pipeline file supplies those defaults (see [Model defaults and precedence](#model-defaults-and-precedence)).

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

Unchosen branches are marked `skipped`, including **all downstream descendants** of the unchosen stage — not only the immediate successor — unless a multi-parent join lists `skipped` in that parent's `on` set. That join waits for its other parents instead of cascade-skipping. Non-accepting paths still cascade. In [`fork-route-cascade.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml), when `clarify` emits `fork_choice: ["design-doc"]`, both `implementation-plan` and `join-doc` are skipped because `join-doc` depends on the unchosen branch (scalar `needs`, so `skipped` is not accepted).

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

A clone-list join still names **one** catalog parent id. Join requires every clone to succeed in both modes. When the join runs, `priorEnvelopes` are success-only (0.7; 0.5 included failures). Sequential also skips remaining clones on first failure; parallel lets sibling clones finish. Details: [envelopes](envelopes.md#clonable-successors). That list field is not used for [generic fan-in](#generic-fan-in) — a `needs` array receives `priorEnvelopesByStage` instead.

Fixtures:

- [`clonable-default-cap.pipeline.yaml`](../tests/fixtures/pipelines/clonable-default-cap.pipeline.yaml) — `clonable: true` with default cap 5
- [`clone-fanout-join.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-join.pipeline.yaml) — fan-out then join
- [`clone-fanout-mix.pipeline.yaml`](../tests/fixtures/pipelines/clone-fanout-mix.pipeline.yaml) — mix with named sibling + fork
- [`clonable-nested-gate.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-gate.pipeline.yaml) — clone toward a non-clonable collect
- [`clonable-nested-fanout.pipeline.yaml`](../tests/fixtures/pipelines/clonable-nested-fanout.pipeline.yaml) — clonable successor of a clone, then a non-clonable join

Walkthrough: [`examples/clonable-fanout/`](../examples/clonable-fanout/).

Rewire of [`examples/archify-on-pr`](../examples/archify-on-pr/) is deferred; that example remains a single `author-diagrams` session until a later change.

### Feedback loops {#feedback-loops}

A stage may declare a **source-owned** `feedback_loop` policy so that, on success, it can either advance downstream (`continue`) or send work back to an earlier ancestor (`send_back`). Feedback loops do **not** add reverse `needs` edges — the catalog DAG stays forward-only; replay is a runtime schedule over the existing route.

```yaml
id: feedback-loop
stages:
  - id: plan
    uses: ./plan.yaml
  - id: implement
    uses: ./implement.yaml
    needs: plan
  - id: review
    uses: ./review.yaml
    needs: implement
    feedback_loop:
      target: implement
      max_replays: 2
      on_max_replays: require_continue
      replay_session: resume
  - id: submit
    uses: ./submit.yaml
    needs: review
    replay_safe: false
```

| Field | Required | Description |
|-------|----------|-------------|
| `target` | yes | Stage id of an earlier ancestor of the source (via `needs`). |
| `max_replays` | yes | Positive integer — how many accepted `send_back` replays the source may take before the max-replays policy applies. |
| `on_max_replays` | yes | `require_continue` — a further `send_back` is rejected (emit fails with exceeded `max_replays`); the source must emit `continue` instead. `wait_for_human` — park for an operator decision (`extend` / `continue` / `abandon`). |
| `replay_session` | yes | `resume` — reopen the prior agent session (`feedback_resume`). `new_session` — start a fresh session for the replayed stage. |

Optional on any stage entry: `replay_safe` (boolean). **Omitted means safe** — the stage may appear on a feedback replay route. Set `replay_safe: false` on stages that must not be replayed (for example a one-shot submit). Catalog validation rejects a loop whose target→source route includes any `replay_safe: false` stage.

**Validation rules**

- The policy lives on the **source** stage (the one that emits `feedback_loop` in its envelope). The target must already be declared and must be an ancestor — not the source itself, not a sibling, not a descendant.
- Neither the source nor the target may be `clonable: true`.
- Unknown `feedback_loop` keys are rejected.
- Persistent fork parents are valid targets (send-back can re-enter a fork parent). Clonable successors are not.

**Runtime behavior (session, forks, artifacts)**

- On `send_back`, Stageflow replays the inclusive route from the target through the source (forward order). Downstream of the source stays held until the loop continues or is abandoned.
- Replayed stages receive a **Feedback Loop Context** block in the agent prompt (`loop_id`, `replay_id`, source envelope, remaining replays, route ids, optional prior attempt / active fork generation). See [Envelopes — Feedback loops](envelopes.md#feedback-loops).
- `replay_session: resume` maps to session mode `feedback_resume` (resume token from the prior attempt). `new_session` maps to `new_session`.
- When the replay route re-fans out a clonable successor, the prior clone cohort is **superseded** and a new fork generation mints fresh instance ids (`{catalogId}~{n}`). Prior clone artifacts remain under their attempt paths; the active generation is the one named in Feedback Loop Context.
- Artifacts stay attempt-scoped. Downstream stages still consume the latest accepted envelopes on the active route; the send-back feedback itself is the source envelope carried in Feedback Loop Context.

Operator / host-down decisions when `on_max_replays: wait_for_human`: [CLI `sf runs feedback-decide`](cli-reference.md#sf-runs-feedback-decide), MCP [`decide_feedback_loop`](mcp.md#decide_feedback_loop), or `POST /api/runs/:runId/stages/:stageId/feedback-decision`.

Fixtures: [`feedback-loop.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop.pipeline.yaml), [`feedback-loop-wait-human.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop-wait-human.pipeline.yaml), [`feedback-loop-clone-fanout.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop-clone-fanout.pipeline.yaml).

Walkthrough: [`examples/feedback-loop/`](../examples/feedback-loop/).

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

### Stage MCP {#stage-mcp}

Pass project MCP servers to a stage on the **pipeline stage entry** (alongside `uses:` or inline body). The loader also accepts `mcp:` in external stage files; a pipeline-entry `mcp` overrides the file value on merge, including `mcp: []` to clear a file list. Prefer the pipeline entry. Omit the field or set `mcp: []` for no author-declared MCP.

```yaml
stages:
  - id: use-echo
    uses: ./use-echo.yaml
    mcp: [echo]
```

Project `.mcp.json` lives at the same root as `stageflow.yaml`:

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["examples/stage-mcp/echo-mcp.mjs"],
      "env": {
        "ECHO_TOKEN": "${ECHO_TOKEN:-local}"
      }
    }
  }
}
```

| Behavior | Detail |
|----------|--------|
| Catalog | `.mcp.json` `{ "mcpServers": { "<name>": { … } } }` at the project root that holds `stageflow.yaml` |
| Interpolation | `${VAR}` and `${VAR:-default}` in `command`, `args`, `env` values, `url`, `headers` values, and `cwd`. Stage attach sets `STAGEFLOW_STAGE_ARTIFACTS_DIR` to the attempt artifacts directory and substitutes `${STAGEFLOW_STAGE_ARTIFACTS_DIR}` in the stage `system_prompt` (Settings Check does not). |
| Spawn root | stdio servers stamp `cwd` to the catalog project root. Relative `command`/`args` paths resolve against that root. A catalog `cwd` must already be an absolute path inside the project root. |
| Validate | `sf validate` checks names, shape, and reserved-name collision. It does not require env vars to be set or a live connect. |
| Run | A required var that is still unset, and a passed server that will not connect, fail the stage at run time before the agent is treated as having those tools. |
| Reserved | The server name `stageflow` is reserved. Stageflow stage tools (`emit_stage_envelope`, `write_stage_artifact`, and `ask_operator` when the stage allows it) stay available without being listed in `mcp`. |
| Settings inspect | Operator console Settings lists git-root `.mcp.json` names and Check connect without a run. Inspect is not attach. |

**Validate-time failures** (author language):

- `.mcp.json` is missing when a stage lists one or more `mcp` names
- A listed name is not in `mcpServers`
- The catalog or a stage list uses the reserved name `stageflow`
- The catalog is not valid JSON, is not an object, is missing `mcpServers`, or a server entry is not an object

If `.mcp.json` is present, validate checks its shape and reserved names even when no stage lists `mcp`. Connect failure and unset required vars fail at **run**, not `sf validate`.

GitHub, Notion, or a company MCP use the same authoring shape when those servers exist in `.mcp.json`.

Pi and Claude both receive the servers named on the stage; transports and protocol features may differ. Walkthroughs: [`examples/stage-mcp/`](../examples/stage-mcp/), [`examples/playwright-mcp/`](../examples/playwright-mcp/) (open a page and save a PNG screenshot; pass `${STAGEFLOW_STAGE_ARTIFACTS_DIR}/page.png` because Playwright named `filename` values resolve against the project checkout, not `--output-dir`), [`examples/context7-mcp/`](../examples/context7-mcp/) (resolve a library, fetch docs, write a brief).

MCP elicitation is unsupported — a passed server cannot ask the operator a question through Stageflow.

Settings can list git-root `.mcp.json` names and Check whether a server can connect without starting a run. That inspect is not attach: YAML `mcp:` still allowlists what a stage receives.

Operator-host MCP (`sf ui` / `sf mcp`) is a different surface — see [MCP](mcp.md).

## External stage files

Stage YAML (referenced via `uses:`) requires:

| Field | Description |
|-------|-------------|
| `id` | Must match the pipeline entry `id` and the filename stem (`sf validate`) |
| `system_prompt` | Agent instructions |

Optional when a pipeline or manifest default can fill it:

| Field | Description |
|-------|-------------|
| `model` | Provider/model string; resolved via [Model defaults and precedence](#model-defaults-and-precedence) |

Optional body fields on the file (not on the `uses:` wrapper): `model` (when inherited from a higher default), `io`, `verify`, `gate_kinds`, `clone_actions`, `timeout_ms` — see [Envelopes — io schemas](envelopes.md#io-schemas) and [Verify](#verify). The loader accepts `skill:` and `mcp:` here; prefer binding them on the pipeline entry (see [Skill binding](#skill-binding) and [Stage MCP](#stage-mcp)). `io.input.schema` is the successor assignment contract (not the child's later `io.output.schema`). Wiring keys (`needs`, `on_verify_fail`, `fork`, `clonable`) are errors on a new-dialect stage file. `clone_actions` on a parent restricts emit clone actions; omit keeps skip, once, and fanout. `timeout_ms` is an optional positive integer millisecond attempt budget (default 60 minutes).

Shared pool example: [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

## Tasks (`*.task.yaml`)

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Task identifier |
| `goal` | yes | What the run should accomplish |
| `context` | no | Background for agents |
| `constraints` | no | Boundaries |
| `checkout` | no | Relative or absolute path to working tree |
| `input` | no | Structured object; when present must match each entry stage's `io.input` |

Prose-only tasks (no `input`) stay valid. If an entry stage declares `io.input` and the task has no `input`, `sf validate` of each file alone still succeeds; start-run / `preparePipeline` emit a `task.entry_input_unmet` warning and continue. Non-entry stages still receive the full task in the agent prompt.

Runnable demo: [`examples/hello-world/`](../examples/hello-world/) — task `input` paired with entry `io.input.schema` (see that README’s “What this demonstrates”). See also [`tests/fixtures/tasks/sample.task.yaml`](../tests/fixtures/tasks/sample.task.yaml).

## Manifest (`stageflow.yaml`)

Declares catalog roots for **`sf validate`** (manifest-all) and operator-console browse. Optional top-level `model` is the global default LLM id for stages that omit both stage and pipeline `model` (see [Model defaults and precedence](#model-defaults-and-precedence)). Optional top-level `agent` selects the default execution backend and is independent of `model`.

```yaml
version: 1
# model: anthropic/claude-sonnet-4-5   # optional global default LLM id
# agent: pi                            # optional global default backend
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

- **`model`**: optional global default; participates in `stage → pipeline → global` resolution.
- **`agent`**: optional global default backend; separate from `model`.
- **`exclude`**: paths omitted from console browse (fixtures may still be loaded by explicit CLI path in tests).
- **`patterns`**: glob for directory scans (defaults shown above).

Scaffold a new project: **`sf init`** creates `stageflow.yaml`, `pipelines/` (with an inline stage in `hello.pipeline.yaml`), and `tasks/` — not a global `stages/` pool.

## Validation

```bash
sf validate --strict                    # manifest-all: pipelines, stages, and tasks from git root
sf validate --pipeline path/to/x.pipeline.yaml --strict   # that pipeline and its stages
sf validate --task path/to/x.task.yaml --strict           # that task
sf migrate-yaml                         # dry-run convert legacy keys to io / verify / on_verify_fail
sf migrate-yaml --write                 # apply
```

Validation checks pipeline shape, `uses:` resolution, DAG (`needs`, cycles), stage file shape, `io` / `verify` / `on_verify_fail`, and task shape. It also resolves the effective `model` per stage (`stage → pipeline → global`); omitting `model` at all three tiers is an error — see [`tests/fixtures/model-hierarchy/missing-all/`](../tests/fixtures/model-hierarchy/missing-all/). When `.mcp.json` is present, it also checks catalog shape and reserved-name collision. When a stage lists `mcp`, it checks those names exist in the catalog. It does not verify provider credentials, checkout paths, env vars, or a live MCP connect. `--strict` does not promote `catalog.legacy_yaml` or `task.entry_input_unmet`. See [`sf migrate-yaml`](cli-reference.md#sf-migrate-yaml).

## CLI run

```bash
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Run state is stored under **`<git-root>/.stageflow/`** regardless of which subdirectory you start `sf ui` from.
