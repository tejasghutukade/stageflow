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
| `schemas` | object | Named JSON Schema map for `$ref: "#/schemas/NAME"` on stage `io` (see [Pipeline schemas](#pipeline-schemas)) |

Bare string stage refs are rejected.

### Stage entries

Each stage is an object with one of:

| Form | Fields | Use when |
|------|--------|----------|
| External | `uses: path/to/stage.yaml` | Stage body lives in another YAML file |
| Inline | `system_prompt`, optional `model`, … | Single-file pipeline |

`id` may be omitted when it is inferable from the `uses:` basename (`*.yaml` or `*.stage.yaml`).

**Wiring** (any entry, including `uses:`): `route`, `entry`, `uses`, `on_verify_fail`, `replay_safe`. A Clone Chain emitter also takes `clone_cap` (integer ≥ 1) and `clone_mode` (`parallel` | `sequential`) — see [Clone Chain](#clone-chain). `skill` and `mcp` may sit on a `uses:` wrapper or on the body — see [Skill binding](#skill-binding) and [Stage MCP](#stage-mcp). `needs`, `fork`, `feedback_loop`, `route_select`, `allow_none`, `clonable`, and `clone_actions` are rejected. `clone_cap` / `clone_mode` on a stage that is not a Clone Chain emitter also fail load.

**Body** (inline entry or external stage file): `system_prompt` (required), `model` (**optional** when a pipeline or manifest default supplies it), `io` (**required** — both `io.input.schema` and `io.output.schema`), `verify`, `gate_kinds`, `skill`, `mcp`, `timeout_ms`. Effective `model` is materialized at pipeline load — see [Model defaults and precedence](#model-defaults-and-precedence). `io.output.schema` is the producer contract for success `payload`; `io.input.schema` is what the stage requires to start. Omitting `io`, a side, or `schema` fails load (`stage.invalid_io`). JSON Schema subset: [Envelopes — io schemas](envelopes.md#io-schemas). `io.output.schema` implies emit-time payload validation on success. `verify` is one list of checks with `when: [emit]`, `[after]`, or both — see [Verify](#verify). Optional `timeout_ms` is a positive integer wall-clock budget for the stage attempt in milliseconds (default 3600000 / 60 minutes when omitted). `clonable` and `clone_actions` are not accepted. `clone_cap` and `clone_mode` belong on the pipeline entry of a Clone Chain emitter, not on the reusable stage body — see [Clone Chain](#clone-chain) and [Rejected clone fields](#rejected-clone-fields).

`uses:` plus any body key except `skill` and `mcp` is rejected (`pipeline.stage_uses_inline_conflict`). `skill` and `mcp` may sit on the `uses:` wrapper.

`on_verify_fail` is pipeline-stage wiring. It may sit beside `uses:` because a reusable stage can recover differently in different pipelines. `verify` belongs on the body (the `uses:` target or the inline entry), not on the wrapper.

### Upgrading older catalogs {#upgrading-older-catalogs}

**Write Author YAML only:** `io` / `verify` / `on_verify_fail` for contracts, and `route` / `entry` / `{ type: loop }` for wiring.

This release still **loads** catalogs that use the previous **contract** keys (second column). Convert them with [`sf migrate-yaml`](cli-reference.md#sf-migrate-yaml) (dry-run default; `--write` to apply). Mixed old and new contract keys in one file fail load — do not author both spellings. Wiring (`needs` / `fork` / `feedback_loop`) is a separate hard cutover — see [Wiring](#upgrading-wiring).

Runtime IR names in TypeScript/JSON after load (`payload_schema`, `pre_emit_checks`, `completion`, `recovery`) are **not** what you write in catalog YAML.

| Write this instead | Legacy author keys (still loaded) |
|--------------------|-----------------------------------|
| `io.output.schema` | `payload_schema:` (top-level field) |
| `io.input.schema` | `clone_input_schema` |
| `verify` items with `when` including `emit` | `pre_emit_checks` |
| `verify` items with `when` including `after` | `completion` |
| `on_verify_fail` | `recovery` |
| `type: artifact` + `basename` + `when: [emit]` | `type: artifact_declared` under `pre_emit_checks` |

**`payload_schema` means two different things:**

- Legacy author field `payload_schema:` → write `io.output.schema` instead.
- Check type `type: payload_schema` under `verify` is **current** and correct: an optional after-phase re-check of the captured payload against `io.output.schema`. Presence of `io.output.schema` already validates on emit; the check type is only if you want that re-check after the attempt.

Before → after (legacy `pre_emit_checks` / `completion` merge into one `verify:` list):

```yaml
# Legacy (still loaded)
pre_emit_checks:
  - id: plan-declared
    type: artifact_declared
    basename: plan.md
completion:
  mode: all
  checks:
    - id: tests
      type: command
      run: npm test

# Write this instead
verify:
  - id: plan-declared
    type: artifact
    basename: plan.md
    when: [emit]
  - id: tests
    type: command
    run: npm test
    # omitted when → [after] for command
```

After you migrate, you can optionally set `STAGEFLOW_LEGACY_YAML=0` to reject leftover legacy authoring keys (`sf migrate-yaml` still reads them). You do not need that env var to author `io` / `verify` / `on_verify_fail`.

#### Wiring: `needs` / `fork` / `feedback_loop` → `route` {#upgrading-wiring}

Contract dual-read is only for `payload_schema` / `pre_emit_checks` / `completion` / `recovery` / `clone_input_schema`. [`sf migrate-yaml`](cli-reference.md#sf-migrate-yaml) converts those keys only. It does **not** rewrite wiring.

`needs`, `fork`, `feedback_loop`, `route_select`, and `allow_none` are a hard cutover: load fails.

- `"needs" is no longer supported — declare the wiring on the source stage's "route" instead`
- `"fork" is no longer supported — use "route" instead; listed route targets always run`
- `"feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead`
- `"route_select" is no longer supported — listed route targets always run`
- `"allow_none" is no longer supported — listed route targets always run`

Those “always run” phrases describe the catalog DAG (every listed `to:` stays on the graph). Optional `if` can still skip a listed successor at runtime.

`clonable`, `clone_actions`, envelope `clone_forks`, and emit-time `skip` / `once` / `fanout` are a hard cutover to [Clone Chain](#clone-chain). There is no dual-read. One run per list item is a sealed emitter → clone child → Join with `clone_cap` / `clone_mode` on the emitter pipeline entry.

Cheat sheet:

- `needs: [A]` on B → on A: `route: [{ to: B }]`; mark roots `entry: true`
- structured need `{ id: A, on: [...] }` on Join → on A: `route: [{ to: Join, on: [...] }]`
- `fork: { select: one|subset }` plus envelope `fork_choice` → list all `to:`; gate with `if` / `on:` — catalog YAML does not pick exclusive successors via `fork_choice`
- top-level `feedback_loop:` → a `{ type: loop, to, max_replays, on_max_replays, replay_session }` entry inside `route`

Join / skip (the child no longer declares parents; default edge is succeeded-only):

- Single-parent: a skipped parent skip-cascades children whose `on` does **not** include `skipped`. Launch still requires a **succeeded** parent. Including `skipped` or `failed` in `on:` only opts that edge out of skip-cascade; it does not launch the child from a skipped or failed parent.
- Multi-parent Join: never skip-cascaded from one parent. Wait until every parent is terminal. Runs if at least one parent succeeded (skipped siblings do not block). Stays pending if any parent failed (even if `on` lists `failed`). Force-skipped if every parent skipped.
- Route `if` miss on a single-parent edge skips that successor (and cascade-skips its single-parent dependents). A required `if` field missing from the payload fails the run (`missing_field`); it is not treated as a miss.

Validate:

- `catalog.legacy_yaml` — contract dual-read warning; `--strict` does not promote
- wiring keys above — hard errors
- illegal [Clone Chain](#clone-chain) shape or policy — hard error (load / `sf validate`)
- `pipeline.route_if_invalid` — error
- `pipeline.route_all_gated` — warning, `ok: true`; `--strict` does not promote
- `pipeline.model_applies` — warning

See [Route wiring](#route), [Generic fan-in](#generic-fan-in), [Clone Chain](#clone-chain), [Feedback loops](#feedback-loops), [`examples/route-wiring-smoke-test/`](../examples/route-wiring-smoke-test/), [`examples/route-if-tour/`](../examples/route-if-tour/).

#### For contributors

Target dialect compiles in `src/config/yamlDialect.ts`. Loading legacy author keys lives in [`src/config/legacyYaml.ts`](../src/config/legacyYaml.ts). Dropping that adapter later means deleting it plus the migrator — not renaming runtime IR.

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
| `[after]` | `command`, `checkout_changes`, `checklist`, `payload_schema` (verify check type — not the legacy `payload_schema:` field; see [Upgrading older catalogs](#upgrading-older-catalogs)) |

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
| `payload_schema` | `id` | — | `after` only; requires `io.output.schema` (optional re-check; emit already validates when that schema is present) |
| `checkout_changes` | `id` | `path_fields` | `after` only |

Check IDs are unique within the stage. `artifact.path` is relative to the stage attempt's artifact directory. Emit `type: artifact` is a basename list check on `envelope.artifacts` (no disk I/O). After `type: artifact` is an on-disk file under the attempt artifacts dir. `gate.kind` must also appear in the stage's `gate_kinds`. Each `checkout_changes.path_fields` entry must name a required array-of-strings field in `io.output.schema`. Optional `type: payload_schema` with `when: [after]` re-checks the captured payload against `io.output.schema` (see [Upgrading older catalogs](#upgrading-older-catalogs) for the legacy field vs this check type); emit-time validation already runs when that schema is present.

### `on_verify_fail` {#on-verify-fail}

`on_verify_fail` is wiring and applies only after an **after-phase** verify failure. It requires at least one after-phase `verify` item on the resolved stage.

| Mode | Required fields | Behavior |
| --- | --- | --- |
| `repair` | `max_attempts`, `retry_safety: idempotent`, `include_failed_checks` | Stageflow starts fresh attempts until the limit, carrying failed-check evidence when configured. |
| `manual` | `retry_safety` | An operator explicitly starts a new attempt with optional guidance or stops recovery for that run. |

Use `manual` for side-effecting work such as publishing or payments. Operator commands keep their names: [`sf runs recover`](cli-reference.md#sf-runs-recover) / [`sf runs verify`](cli-reference.md#sf-runs-verify), MCP [`recover_manual_stage`](mcp.md#recover_manual_stage), HTTP `/api/runs/:id/stages/:id/recovery`. See [Verified Stage Execution](verified-stage-execution.md).

### Pipeline schemas {#pipeline-schemas}

Optional pipeline-file `schemas:` is the `$ref` root for this release. Refs are JSON Pointer `#/schemas/NAME`. Cycles fail load. `schemas:` on an include fragment fails load. Isolated stage validate of a `$ref`-only schema fails with `stage.unresolved_schema_ref`; pipeline validate resolves after attach.

Sequential and fan-in edges: consumer `io.input` must be a structural subset of **each** parent's `io.output`. Pipeline load and `sf validate` report a mismatch as `pipeline.io_incompatible`. Compatible vs incompatible handoffs: [`11-sequential-io-handoff.pipeline.yaml`](../examples/route-wiring-smoke-test/11-sequential-io-handoff.pipeline.yaml), [`rejected/17-reject-io-incompatible.pipeline.yaml`](../examples/route-wiring-smoke-test/rejected/17-reject-io-incompatible.pipeline.yaml). Richer `$ref`/nested/array subset example: [`12-complex-io-schemas.pipeline.yaml`](../examples/route-wiring-smoke-test/12-complex-io-schemas.pipeline.yaml). All-`$ref` input and output: [`13-ref-io-handoff.pipeline.yaml`](../examples/route-wiring-smoke-test/13-ref-io-handoff.pipeline.yaml); incompatible `$ref` pair: [`rejected/21-reject-ref-io.pipeline.yaml`](../examples/route-wiring-smoke-test/rejected/21-reject-ref-io.pipeline.yaml).

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
    entry: true
    route:
      - to: review
    io:
      input:
        schema:
          type: object
      output:
        schema:
          $ref: "#/schemas/story-slice"
  - id: review
    system_prompt: Review the slice.
    io:
      input:
        schema:
          $ref: "#/schemas/story-slice"
      output:
        schema:
          type: object
```

Runnable demo with `uses:` stages: [`examples/feature-loop/`](../examples/feature-loop/) (`schemas.story-assignment` → `plan` `io.input.schema`).

**`uses:` paths are relative to the pipeline file's directory.**

Linear chain with external stages:

```yaml
id: linear-explicit
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
    entry: true
    route:
      - to: design-doc
  - id: design-doc
    uses: ../stages/design-doc.yaml
    route:
      - to: implementation-plan
  - id: implementation-plan
    uses: ../stages/implementation-plan.yaml
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

Parallel fan-out: multiple forward `to:` entries on the source. Listed `to:` stay on the DAG. Default `on:` is succeeded-only. After the source **succeeds**, a single-parent successor can run (then `if`, if present, is evaluated). Including `failed` or `skipped` in `on:` opts that edge out of skip-cascade; it does not launch a child from a skipped or failed parent. Optional `if` can skip a listed successor after success. The completing agent does not pick which successors run.

```yaml
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
    entry: true
    route:
      - to: design-doc
      - to: implementation-plan
  - id: design-doc
    uses: ../stages/design-doc.yaml
  - id: implementation-plan
    uses: ../stages/implementation-plan.yaml
```

See [`tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml`](../tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml).

`route` is a list of entries. Forward entries name `to:`, optional `on:` (`succeeded` | `failed` | `skipped`; default succeeded-only skip-cascade policy), and optional `if`. Multiple `to:` entries fan out; `if` is a runtime gate on that edge, not a missing DAG edge. Load and pipeline create invert preserve `if` on the matching outbound Route entry. HTTP create `needs` remains ungated (`id`/`on` or a parent id string). Keyed generic fan-in is one child targeted by two or more parents — see [Generic fan-in](#generic-fan-in).

### Generic fan-in {#generic-fan-in}

A stage may wait for two or more catalog parents. Each parent lists a forward `to:` to the join. Optional `on:` on a **single-parent** edge is skip-cascade policy (default succeeded-only). On a Join inbound edge, `on` does **not** decide Join readiness. The Join waits until every parent is terminal; it stays pending if any parent failed (even if `on` lists `failed`); it force-skips if every parent skipped; otherwise it follows the succeeded / `if` rules below. Skipped siblings do not block a Join that has a succeeded parent. Optional `if` on that same entry is evaluated against **that parent's** output payload after success.

```yaml
id: diamond-fan-in
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
    entry: true
    route:
      - to: research
      - to: validation
  - id: research
    uses: ../stages/research.yaml
    route:
      - to: synthesize
  - id: validation
    uses: ../stages/validation.yaml
    route:
      - to: synthesize
  - id: synthesize
    uses: ../stages/synthesize.yaml
```

Listing `failed` / `skipped` on a Join inbound `on:` (skip-cascade policy, not a launch after failure):

```yaml
  - id: research
    uses: ../stages/research.yaml
    route:
      - to: synthesize
        on: [succeeded, failed, skipped]
```

Listing `failed` or `skipped` on a Join inbound edge does not run the Join after failure. Skipped siblings still do not block when another parent succeeded.

The Join starts only after every declared parent is terminal. A false inbound `if` does **not** skip the child while another parent is still running.

After every parent **succeeded**, the child **runs** only if every inbound edge fired (`if` true — including nested `all` / `any` / `not` composition — or no `if`). It then opens with **every** parent's success envelope (complete set, no hole). If any inbound `if` missed, the child is **skipped** — not pending forever, not failed, not opened with a partial envelope set. Sequential `io` subset checks still apply when the Join child runs; a skipped Join child is not opened.

A failed parent still **blocks** the Join. `if` does not redefine failure joins.

Pipelines whose Routes have **no** forward `if` keep today's Join: it **runs if at least one parent succeeded**. Skipped parents do not block, and their envelopes are omitted from join input. The Join stays pending if a parent failed. It is skipped if every parent skipped.

The all-inbound-fired check applies only when every parent succeeded. If some parents skipped and at least one succeeded, the Join can still run even if a succeeded parent's inbound `if` missed; skipped parents' envelopes stay omitted from join input.

A false `if` on a single-parent edge skips that successor and skip-cascades its single-parent dependents. A Join with two or more parents is never skip-cascaded from one parent.

Join input is `priorEnvelopesByStage`, keyed in YAML declaration order. `priorEnvelope` is `null`. See [Envelopes](envelopes.md#downstream-consumption). Walkthrough: [`examples/generic-fan-in/`](../examples/generic-fan-in/).

A [Clone Chain](#clone-chain) Join's parents are that chain's Clone Instances. Every instance must succeed; a failed or skipped instance is a failed Join parent and blocks the Join. That Join does not run on a partial set.

Fixtures:

- [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml) — static diamond
- [`diamond-fan-in-accepted.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in-accepted.pipeline.yaml) — inbound `on` lists `failed` and `skipped` (skip-cascade policy; does not run the Join after a failed parent)
- [`route-if-join.pipeline.yaml`](../tests/fixtures/pipelines/route-if-join.pipeline.yaml) — Join gated by inbound `if`s

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
```

Fragment files contain a `stages:` array (same entry shapes as the parent pipeline). Paths in `local:` are relative to the pipeline file's directory. Top-level `model` / `agent` on a fragment are ignored; only the root pipeline file supplies those defaults (see [Model defaults and precedence](#model-defaults-and-precedence)).

Nested `include:` is allowed. Cycles and duplicate stage ids across files are rejected. Includes merge before the declaring file's own `stages`.

Fixture: [`tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml`](../tests/fixtures/pipeline-owned/include-merge/main.pipeline.yaml).

### Route wiring {#route}

Wiring is declared on the **source** stage as `route`. Each forward entry names a `to:` target. Optional `on:` is skip-cascade / acceptance policy (default succeeded-only), not a launch schedule for failed or skipped parents. Optional `if` is a payload predicate evaluated after the source **succeeds**, against that stage's output payload only. A pipeline that uses `route` must mark at least one `entry: true` root.

Listed forward `to:` targets still appear on the DAG. A miss skips that successor at runtime; it does not remove the edge. After success, an entry with no `if` is eligible to run (single-parent) or participates in Join readiness as above. `on` does not launch from failed or skipped. Two matching `if`s on different targets both fire (not first-match-wins). Duplicate `to:` in one Route stays illegal. The completing agent does **not** pick which successors run, and catalog YAML does not produce a `fork` on the resolved DAG. HITL (`ask_operator`) inside a stage is not a parallel router: `if` still runs only after that stage succeeds and emits a payload.

`if` is a predicate, not a string: a leaf `{ field, op, value }` or a composition node `{ all: [...] }` | `{ any: [...] }` | `{ not: {...} }` (including nesting such as `not` around `all`, or `any` of `all`s). A node must be exactly one of those shapes; mixing leaf keys with `all` / `any` / `not`, or any unknown key, is `pipeline.route_if_invalid`. Empty `all` / `any` / `in` / `not_in` lists are invalid. There is no `exists` operator and no else/fallback arm.

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`. `eq` / `ne` are only for `string` | `number` | `integer` | `boolean` schema fields. `gt` / `gte` / `lt` / `lte` are only for `number` | `integer`. Comparison is type-strict (`1` is not `"1"`). `in` / `not_in` mean the **scalar** field is a member of a non-empty literal list whose items share the field's scalar type — not array-contains. `value` is required for every operator.

`field` is a dot-separated path into the source output payload. Validate walks the source `io.output.schema` after `$ref` / pipeline `schemas:` expansion. Every segment must be a property of an object schema and listed in that object's `required`. Array schemas and index segments (`items.0`) are `pipeline.route_if_invalid`. Optional path segments (not in `required`) are also invalid, including after `$ref` inlining.

Illegal `if` is error `pipeline.route_if_invalid` (not `pipeline.dag_error`). When every forward `to:` on a stage has `if`, validate warns `pipeline.route_all_gated` with `ok: true`; `--strict` does not promote that warning. Sequential `io` subset checks still apply on a gated edge that fires; a skipped child is not opened.

`if` is legal only on a **forward** Route Entry after success. It is `pipeline.route_if_invalid` on a `{ type: loop }` entry, or when combined with `on` other than succeeded-only. Entries without `if` keep `on:` as skip-cascade policy (including `on: [failed]`). Backward or circular forward `to:` without `type: loop` remains `pipeline.dag_error`.

`fork`, `route_select`, and `allow_none` are rejected:

- `"fork" is no longer supported — use "route" instead; listed route targets always run`
- `"route_select" is no longer supported — listed route targets always run`
- `"allow_none" is no longer supported — listed route targets always run`

Those messages mean listed `to:` stay on the DAG (no agent exclusive pick); `if` can still skip a listed successor.

`on: [failed]` on `hotfix` keeps hotfix from being skip-cascaded when `run-tests` fails; it does **not** launch hotfix. Launch still requires a succeeded parent. Prefer `if` on a succeeded payload for deterministic branching.

```yaml
id: release-gate
stages:
  - id: run-tests
    uses: ./run-tests.yaml
    entry: true
    route:
      - to: ship
        on: [succeeded]
      - to: hotfix
        on: [failed]
  - id: hotfix
    uses: ./hotfix.yaml
  - id: ship
    uses: ./ship.yaml
```

```yaml
id: fan-out
stages:
  - id: decide
    uses: ./decide.yaml
    entry: true
    route:
      - to: branch-a
      - to: branch-b
  - id: branch-a
    uses: ./branch-a.yaml
  - id: branch-b
    uses: ./branch-b.yaml
```

```yaml
id: gated-page
stages:
  - id: triage
    uses: ./triage.yaml
    entry: true
    route:
      - to: page
        if:
          all:
            - field: severity
              op: eq
              value: high
            - field: customer.tier
              op: in
              value: [gold, silver]
      - to: notify
  - id: page
    uses: ./page.yaml
  - id: notify
    uses: ./notify.yaml
```

Fixtures:

- [`fork-one-of-two.pipeline.yaml`](../tests/fixtures/pipelines/fork-one-of-two.pipeline.yaml) — two listed targets, both run
- [`fork-route-cascade.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-cascade.pipeline.yaml) — fan-out plus a downstream child of one arm
- [`fork-route-subset.pipeline.yaml`](../tests/fixtures/pipelines/fork-route-subset.pipeline.yaml) — three listed targets, all run
- [`parallel-after-clarify.pipeline.yaml`](../tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml) — same fan-out shape
- [`route-if-eq.pipeline.yaml`](../tests/fixtures/pipelines/route-if-eq.pipeline.yaml) — gated `eq` plus always-run sibling
- [`route-if-composition.pipeline.yaml`](../tests/fixtures/pipelines/route-if-composition.pipeline.yaml) — `not` around `all`, nested required paths, `in`
- [`route-if-two-match.pipeline.yaml`](../tests/fixtures/pipelines/route-if-two-match.pipeline.yaml) — two matching `if`s both run

Walkthrough: [`examples/route-wiring-smoke-test/`](../examples/route-wiring-smoke-test/) (`14-if-eq-gating.pipeline.yaml`, `16-if-composition.pipeline.yaml`).

### Clone Chain {#clone-chain}

A Clone Chain is a sealed inbound path of three roles: **emitter → clone child → Join**. Detection is from that shape plus a named `$ref`, not from a `clonable` flag. Use it when one stage produces a list and the next stage should run once per element (research items, ops tickets, story slices, or any other list).

- The emitter's `io.output.schema` is an object with exactly one array property whose `items` are `{ $ref: '#/schemas/<id>' }` (a Clone Array). Sibling fields next to that array are allowed.
- The clone child's entire `io.input.schema` is `{ $ref: '#/schemas/<id>' }` with the same id.
- The emitter's only forward `route` is the clone child; the clone child's only forward `route` is the Join. Neither inbound edge uses `if`. No other stage routes to the Join.
- The emitter's pipeline entry requires `clone_cap` (integer ≥ 1) and `clone_mode` (`parallel` | `sequential`). Those keys are invalid on any other stage and invalid on a stage file body.
- On emitter success, N is the Clone Array length. Stageflow mints Clone Instances `{child}~{n}` (1-based, including `~1` when N is 1). Each instance receives that array element only. The Join waits on those instances and receives their success envelopes in array order.

**Empty and over-cap.** Load compiles the Clone Array as `minItems: 1` / `maxItems: <clone_cap>`. An empty array or a length above the Clone Cap fails the **emitter emit** — Stageflow does not skip the chain or truncate the list. Gate a zero-item path **before** the emitter (ordinary `if` / routing on an earlier stage), not by emitting an empty array.

**Clone Mode** is catalog policy on the emitter entry:

- `parallel` — Clone Instances may overlap. A failure does not stop siblings that are already running; they may finish after the failure. The Join stays blocked.
- `sequential` — Clone Instances run in Clone Array order. A failure skips instances that have not started. A successful retry of the failed instance then starts the next skipped instance.

In both modes a failed or skipped Clone Instance is a failed Join parent. The Join does not run on a hole.

**Loop.** The Join may Loop only to a stage **before** the emitter. The emitter, clone child, and Join are not Loop targets. The clone child cannot declare a Loop and cannot `send_back`.

**Illegal at load** (`sf validate` / pipeline load). A pipeline that looks like a Clone Chain but violates sealed shape fails immediately:

- Extra routes on the emitter or clone child
- `if` on either chain inbound edge
- An extra parent routing to the Join
- Two clone children from one emitter
- Nested Clone Array (a Clone Instance emitting another Clone Array)
- Two named-`$ref` array fields on the emitter
- Inline (anonymous) array items
- A root-level array payload
- `clone_cap` / `clone_mode` on a stage that is not the emitter
- Shared emitter, clone child, or Join across two Clone Chains

A pipeline may have many Clone Chains if they share no emitter, clone child, or Join. A Join may later be the emitter of a following Clone Chain.

Canonical sample: [`tests/fixtures/pipelines/clone-chain-smallest.pipeline.yaml`](../tests/fixtures/pipelines/clone-chain-smallest.pipeline.yaml).

```yaml
id: clone-chain-smallest
model: anthropic/claude-sonnet-4-5
schemas:
  Issue:
    type: object
    required: [id, title]
    properties:
      id:
        type: string
      title:
        type: string
stages:
  - id: emit-items
    entry: true
    clone_cap: 4
    clone_mode: parallel
    route:
      - to: handle-item
    system_prompt: Emit a list of issues.
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
          required: [items]
          properties:
            items:
              type: array
              items:
                $ref: "#/schemas/Issue"
            summary:
              type: string
  - id: handle-item
    route:
      - to: gather
    system_prompt: Handle one issue.
    io:
      input:
        schema:
          $ref: "#/schemas/Issue"
      output:
        schema:
          type: object
  - id: gather
    system_prompt: Gather clone results.
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
```

### Rejected clone fields {#rejected-clone-fields}

Older `#clonable-successors` links should use this heading.

`clonable`, `clone_actions`, and envelope `clone_forks` are not accepted. `clone_cap` / `clone_mode` on a stage that is not a Clone Chain emitter fail load. Those fields fail with a message naming the field and pointing at a Clone Chain. There is no dual-read of `skip` / `once` / `fanout`.

Rewire of [`examples/archify-on-pr`](../examples/archify-on-pr/) is deferred; that example remains a single `author-diagrams` session until a later change.

### Feedback loops {#feedback-loops}

A stage may declare a **source-owned** loop as a `type: loop` entry inside `route` so that, on success, it can either advance downstream (`continue`) or send work back to an earlier ancestor (`send_back`). Loop entries do **not** add reverse DAG edges — the catalog DAG stays forward-only; replay is a runtime schedule over the existing route.

```yaml
id: feedback-loop
stages:
  - id: plan
    uses: ./plan.yaml
    entry: true
    route:
      - to: implement
  - id: implement
    uses: ./implement.yaml
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

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | Must be `loop`. |
| `to` | yes | Stage id of an earlier ancestor of the source (via forward `route`). |
| `max_replays` | yes | Positive integer — how many accepted `send_back` replays the source may take before the max-replays policy applies. |
| `on_max_replays` | yes | `require_continue` — a further `send_back` is rejected (emit fails with exceeded `max_replays`); the source must emit `continue` instead. `wait_for_human` — park for an operator decision (`extend` / `continue` / `abandon`). |
| `replay_session` | yes | `resume` — reopen the prior agent session (`feedback_resume`). `new_session` — start a fresh session for the replayed stage. |

Optional on any stage entry: `replay_safe` (boolean). **Omitted means safe** — the stage may appear on a feedback replay route. Set `replay_safe: false` on stages that must not be replayed (for example a one-shot submit). Catalog validation rejects a loop whose target→source route includes any `replay_safe: false` stage.

**Validation rules**

- The policy lives on the **source** stage (the one that emits `feedback_loop` in its envelope). The target must already be declared and must be an ancestor — not the source itself, not a sibling, not a descendant.
- A stage may declare at most one `type: loop` route entry.
- `if` is not allowed on a `{ type: loop }` entry (`pipeline.route_if_invalid`).
- The top-level `feedback_loop` field is rejected — use a `type: loop` entry inside `route`.

**Runtime behavior (session, forks, artifacts)**

- On `send_back`, Stageflow replays the inclusive route from the target through the source (forward order). Downstream of the source stays held until the loop continues or is abandoned.
- Replayed stages receive a **Feedback Loop Context** block in the agent prompt (`loop_id`, `replay_id`, source envelope, remaining replays, route ids, optional prior attempt / active fork generation). See [Envelopes — Feedback loops](envelopes.md#feedback-loops).
- `replay_session: resume` maps to session mode `feedback_resume` (resume token from the prior attempt). `new_session` maps to `new_session`.
- Artifacts stay attempt-scoped. Downstream stages still consume the latest accepted envelopes on the active route; the send-back feedback itself is the source envelope carried in Feedback Loop Context.

Operator / host-down decisions when `on_max_replays: wait_for_human`: [CLI `sf runs feedback-decide`](cli-reference.md#sf-runs-feedback-decide), MCP [`decide_feedback_loop`](mcp.md#decide_feedback_loop), or `POST /api/runs/:runId/stages/:stageId/feedback-decision`.

Fixtures: [`feedback-loop.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop.pipeline.yaml), [`feedback-loop-wait-human.pipeline.yaml`](../tests/fixtures/pipelines/feedback-loop-wait-human.pipeline.yaml).

Walkthrough: [`examples/feedback-loop/`](../examples/feedback-loop/).

### Skill binding {#skill-binding}

Bind a Pi skill to a stage on the **pipeline stage entry** (alongside `uses:` or inline body). The loader also accepts `skill:` in external stage files; a pipeline-entry `skill` overrides the file value on merge. Prefer the pipeline entry.

```yaml
stages:
  - id: author-diagrams
    uses: ./author-diagrams.yaml
    skill: archify
```

| Behavior | Detail |
|----------|--------|
| Resolution | Looks up `.pi/skills/NAME/SKILL.md` under the operator checkout (`--operator-cwd` / `STAGEFLOW_OPERATOR_CWD`) and the Pi agent skills dir |
| Startup | Stage fails before the agent session if the skill is not installed |
| Agent prompt | Skill instructions are injected for the stage attempt |

Install skills before `sf run` in CI:

```bash
sf skills install --from-zip https://example.com/skill.zip --skill-name archify
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
| Catalog | `.mcp.json` `{ "mcpServers": { "NAME": { … } } }` at the project root that holds `stageflow.yaml` |
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

Required on the file (not on the `uses:` wrapper): `io.input.schema` and `io.output.schema`. Optional body fields: `model` (when inherited from a higher default), `verify`, `gate_kinds`, `timeout_ms` — see [Envelopes — io schemas](envelopes.md#io-schemas) and [Verify](#verify). The loader accepts `skill:` and `mcp:` here; prefer binding them on the pipeline entry (see [Skill binding](#skill-binding) and [Stage MCP](#stage-mcp)). `io.input.schema` is the successor assignment contract (not the child's later `io.output.schema`). Wiring keys (`route`, `entry`, `on_verify_fail`, `needs`, `fork`, `route_select`, `allow_none`, `clonable`, `clone_cap`, `clone_mode`) are errors on an external stage file (body only — put wiring on the pipeline entry). `timeout_ms` is an optional positive integer millisecond attempt budget (default 60 minutes).

Shared pool example: [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

## Tasks (`*.task.yaml`)

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Task identifier |
| `goal` | yes | What the run should accomplish |
| `context` | no | Background for agents |
| `constraints` | no | Boundaries |
| `checkout` | no | Relative or absolute path to working tree |
| `input` | no | Structured object matched against each entry stage's `io.input`; omitted is `{}` |

Prose-only tasks (no `input`) stay valid as files. If an entry stage declares `io.input.schema` and the task omits `input`, start-run / `preparePipeline` treat it as `{}` and fail with `task.invalid_shape` when that does not match. `sf validate` of the task file alone still succeeds. Non-entry stages still receive the full task in the agent prompt.

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
sf migrate-yaml                         # dry-run convert contract keys to io / verify / on_verify_fail (not wiring)
sf migrate-yaml --write                 # apply
```

Validation checks pipeline shape, `uses:` resolution, DAG (`route`, cycles), stage file shape, `io` / `verify` / `on_verify_fail`, and task shape. It also resolves the effective `model` per stage (`stage → pipeline → global`); omitting `model` at all three tiers is an error — see [`tests/fixtures/model-hierarchy/missing-all/`](../tests/fixtures/model-hierarchy/missing-all/). When `.mcp.json` is present, it also checks catalog shape and reserved-name collision. When a stage lists `mcp`, it checks those names exist in the catalog. It does not verify provider credentials, checkout paths, env vars, or a live MCP connect. `sf migrate-yaml` converts contract keys (`payload_schema` / `pre_emit_checks` / `completion` / `recovery` / `clone_input_schema`) only — it does not rewrite wiring. `needs` / `fork` / `feedback_loop` / `route_select` / `allow_none` are hard errors. Illegal [Clone Chains](#clone-chain) fail load and `sf validate`. `pipeline.route_if_invalid` is an error. `catalog.legacy_yaml` is a contract dual-read warning; `--strict` does not promote it. `pipeline.route_all_gated` and `pipeline.model_applies` are warnings (`ok: true`); `--strict` does not promote them. See [`sf migrate-yaml`](cli-reference.md#sf-migrate-yaml) and [Upgrading older catalogs](#upgrading-older-catalogs).

## CLI run

```bash
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Run state is stored under **`GIT_ROOT/.stageflow/`** regardless of which subdirectory you start `sf ui` from.
