# YAML reference

Exact keys, where each one may sit, and what the loader does with it. Every rule here was checked against the Stageflow loader. Where the validator is silent about a mistake, the entry says so; catch those with `scripts/check-catalog-keys.mjs`.

## Contents

- [Files and names](#files-and-names)
- [Manifest: stageflow.yaml](#manifest-stageflowyaml)
- [Pipeline file](#pipeline-file)
- [Stage entries and stage files](#stage-entries-and-stage-files)
- [io schemas](#io-schemas)
- [route entries](#route-entries)
- [verify items](#verify-items)
- [on_verify_fail](#on_verify_fail)
- [gate_kinds](#gate_kinds)
- [Model, agent, independence, timeout](#model-agent-independence-timeout)
- [Task file](#task-file)
- [Include fragments](#include-fragments)
- [Legacy and rejected keys](#legacy-and-rejected-keys)

## Files and names

| Kind | Filename | Rules |
|---|---|---|
| Manifest | `stageflow.yaml` at the project root | Lists catalog roots. Optional, but without it nothing shows in the console. |
| Pipeline | `<id>.pipeline.yaml` | `id` should equal the filename stem. Put it under a `catalog.pipelines` root. |
| Stage file | `<id>.yaml` beside the pipeline | `id` must equal the stem (`stage.id_filename_mismatch`) and the pipeline entry `id` (`pipeline.stage_id_mismatch`). |
| Task | `<id>.task.yaml` | Under a `catalog.tasks` root, usually beside the pipeline. |
| Trigger | `<id>.trigger.yaml` | Under a `catalog.triggers` root. See [capabilities.md](capabilities.md#triggers). |
| Project MCP | `.mcp.json` at the project root | Server names that stage `mcp:` lists refer to. |

Ids: lowercase kebab case, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. `sf validate` accepts `Stage_A`. The console create APIs and MCP `create_stage_file` and `create_task_file` reject it. `create_pipeline`, `create_stage` and `create_task` do not. Always use kebab case.

## Manifest: stageflow.yaml

```yaml
version: 1
model: CHANGE_ME/<provider-model>
catalog:
  pipelines:
    - pipelines
    - workshop
  tasks:
    - tasks
    - workshop
  triggers:
    - triggers
  exclude:
    - tests/fixtures
```

- `catalog.pipelines` and `catalog.tasks` are required lists of directories, scanned recursively. Optional: `triggers`, `evals`, `datasets`, `exclude`, and `patterns` (`pipeline`, `task`, `trigger`, `eval`, `dataset` globs; the defaults are `*.pipeline.yaml`, `*.task.yaml`, `*.trigger.yaml`).
- Top-level `model`, `agent` and `independence` are the lowest-tier defaults for every pipeline.
- `sf validate --strict` with no scope flag promotes `catalog.manifest_missing` and `catalog.empty_catalog` to errors. With `--pipeline` it does not read the manifest roots at all.

## Pipeline file

| Key | Required | Notes |
|---|---|---|
| `id` | yes | Kebab case; match the filename stem. |
| `stages` | yes | Non-empty list of stage entries. |
| `model` | one tier must set it | Default for stages without their own `model`. |
| `agent` | no | Execution backend: `pi` or `claude`. Separate from `model`. Channels and memories need `pi`. |
| `independence` | no | `strict`, `persistent` or `open`. |
| `schemas` | no | Named JSON schemas, referenced as `$ref: "#/schemas/<name>"`. |
| `requires` | no | `[{ tool, version? }]`, merged with stage `requires`. |
| `channels` | no | Pipeline-level channel defaults (see [capabilities.md](capabilities.md#channels)). |
| `memories` | no | List of memory ids. Pipeline level only. |
| `include` | no | `[{ local: ./fragment.yaml }]`. |

Unknown top-level keys are ignored without a finding. In particular, a top-level `browser:` is never read; put `browser` on the stages that browse.

## Stage entries and stage files

A stage entry in `stages:` is either inline (wiring and body together) or a `uses:` wrapper that points at a stage file.

**Wiring keys** (pipeline entry only): `id`, `uses`, `route`, `entry`, `on_verify_fail`, `replay_safe`, `clone_cap`, `clone_mode`.

**Body keys** (inline entry or stage file):

| Key | Notes |
|---|---|
| `system_prompt` | Required. |
| `io` | Required: `io.input.schema` and `io.output.schema`. |
| `model` | Overrides the pipeline model. |
| `independence` | `strict`, `persistent` or `open`. |
| `checkout_context` | `true` loads checkout context into the stage. Body only; needs a task checkout binding at run time. |
| `gate_kinds` | Turns on `ask_operator` with these kinds. |
| `verify` | List of checks. |
| `timeout_ms` | Positive integer; default 3600000 (one hour) per attempt. |
| `skill` | One Pi skill name. Body only. |
| `mcp` | List of MCP server names. |
| `secrets` | List of secret names or `{ name, as: env }`. |
| `requires` | `[{ tool, version? }]`. |
| `browser` | Browser profile and login check. |
| `channels` | One channel. Body only. |
| `email` | `[{ accountId, operations }]` for console-configured email accounts. |

A stage file may also carry `id` and `agent`. The stage `agent` does not select the backend. A value of `claude` can still reject run start when the process is root (`claude_as_root`), even if the pipeline backend is `pi`.

**Placement rules:**

- A `uses:` wrapper may carry wiring keys plus only `mcp`, `secrets`, `requires` and `browser`. Any other body key beside `uses:` is `pipeline.stage_uses_inline_conflict`; `skill` there is `pipeline.stage_wrapper_skill_rejected`. Put them in the stage file.
- A wiring key in a stage file is `stage.invalid_shape`. Put `route`, `entry` and `on_verify_fail` on the pipeline entry.
- An unknown key on a pipeline entry is `pipeline.invalid_shape`. An unknown key in a stage file is ignored without a finding, so `gate_kind:` or `verfy:` silently drops the gate or the check.

Inline form, useful for small pipelines:

```yaml
id: inline-demo
model: CHANGE_ME/<provider-model>
stages:
  - id: collect
    entry: true
    route:
      - to: report
    system_prompt: |
      Collect the facts the task goal asks for. Emit a success envelope with a
      payload containing facts, a list of short strings.
    io:
      input: { schema: { type: object } }
      output:
        schema:
          type: object
          required: [facts]
          properties:
            facts: { type: array, items: { type: string } }
  - id: report
    system_prompt: |
      Write a one-paragraph report from payload.facts with write_stage_artifact
      as report.md, then emit success listing that artifact.
    io:
      input:
        schema:
          type: object
          required: [facts]
          properties:
            facts: { type: array, items: { type: string } }
      output: { schema: { type: object } }
```

## io schemas

- Both sides are required on every stage; a missing side is `stage.invalid_io`.
- Supported subset: `type` (`object`, `string`, `number`, `integer`, `boolean`, `array`) on every node, `properties`, `required`, `items` (required for arrays), `additionalProperties` (boolean), `enum`, `minimum`, `maximum`, `minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`, `nullable`, and `$ref: "#/schemas/<name>"`. No `oneOf` or `anyOf`: a node without `type` is `stage.invalid_io`. Extra keys such as `description` are allowed.
- `io.output.schema` validates the success payload at emit time; the agent retries in the same turn if it does not match.
- **Compatibility:** each child's `io.input.schema` must be satisfied by every parent's `io.output.schema` (every required input field must be a required output field of each parent with a compatible type). Otherwise `pipeline.io_incompatible`. That check is skipped for a Clone Chain emitter parent. The safe defaults: child input `{ type: object }`, or the same named schema on both sides.
- **Entry input:** the entry stage's `io.input.schema` is checked against the task `input` only when a run starts (a mismatch fails the run with `task.invalid_shape`). `sf validate` does not check it; `scripts/check-catalog-keys.mjs --task` does.

## route entries

Wiring lives on the source stage. A child never lists its parents.

Forward entry: `{ to, on?, if? }`.

- `to`: an existing stage id. Unknown or duplicate targets, and forward cycles, are `pipeline.dag_error`.
- `on`: skip-cascade policy, a subset of `succeeded`, `failed`, `skipped` (default `[succeeded]`). It never launches a child from a failed or skipped parent; it only stops the skip from cascading.
- `if`: evaluated after the source succeeds, against its payload. Leaf `{ field, op, value }` or `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }`. Ops: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, type-strict. Every segment of `field` (dot path, no array indexes) must be `required` in the source `io.output.schema`. Two matching `if`s both fire; there is no else.

Loop entry: `{ type: loop, to, max_replays, on_max_replays, replay_session }`.

- `to`: an ancestor of the source. `max_replays`: positive integer. `on_max_replays`: `require_continue` (a further send-back is rejected) or `wait_for_human` (an operator decides). `replay_session`: `resume` or `new_session`.
- At most one loop entry per stage, and no `if` on it.
- `feedback_loop` is optional on the success envelope. `send_back` with `target` loops. Omit it, or send `{ action: continue }`, to take the forward routes.
- `replay_safe: false` on a stage entry keeps it from being replayed; a loop whose replay range includes such a stage is rejected.

`entry: true` marks a root. Once any stage has a `route`, at least one root must carry it (`pipeline.dag_error` "no stage is marked entry: true"). A pipeline with no `route` at all needs none.

## verify items

`verify` is a list on the stage body. Each item has `id` (unique in the stage), `type`, and optionally `when`: `[emit]`, `[after]` or both. Emit-phase checks reject the emit and let the agent fix it in the same turn. After-phase checks run once the stage has emitted and fail the attempt.

| type | Fields | Phases (default) | Use |
|---|---|---|---|
| `gate` | `kind` (must be in `gate_kinds`) | emit; `after` is legal | Success only after the operator accepted or answered. |
| `artifact` | emit: a single file name (`basename`, or the file name of `path`); after: `path` (a `basename` is also accepted) and optional `nonempty` | either; `when` is required | A named file written with `write_stage_artifact` exists. |
| `command` | `run`, `cwd`, `timeout_ms` | after; cannot use emit | Stageflow runs `bash -c <run>` after emit; exit 0 passes. |
| `checklist` | `items` | after; cannot use emit | The envelope's `checklist_attestations` must attest every item string exactly. |
| `payload_schema` | none | after; cannot use emit | Re-checks the payload against `io.output.schema`. |
| `checkout_changes` | `path_fields` | after; cannot use emit | The checkout really changed, and the listed payload fields name the changed paths. Each field must be a required array of strings in `io.output.schema`. |
| `browser_login` | none | after; cannot use emit | The stage's `browser.check` reports logged in. Needs `browser.check`; not with `headed: false`. |

Unknown fields on a verify item are `pipeline.invalid_completion`. Add an after-phase `artifact` check only where a named file needs hard proof, not on every stage.

## on_verify_fail

On the pipeline entry, never in a stage file. Needs at least one after-phase verify item on that stage (`pipeline.invalid_recovery` otherwise).

| Key | Values |
|---|---|
| `mode` | `repair` (new attempt with the failed checks in context) or `manual` (wait for an operator) |
| `max_attempts` | Positive integer; required for `repair` |
| `retry_safety` | `idempotent` or `side_effecting`; `repair` requires `idempotent` |
| `include_failed_checks` | Boolean, default `true` |

Use `repair` for work that is safe to redo (edits, tests, documents). Use `manual` with `side_effecting` for anything that pushes, publishes, sends or pays.

## gate_kinds

`confirm`, `free_text`, `artifact_backed`, `multi_question`. Omitted or `[]` means the stage has no `ask_operator` tool. Anything else is `stage.invalid_gate_kinds`.

## Model, agent, independence, timeout

- **Model precedence:** stage `model`, then pipeline `model`, then `stageflow.yaml` `model`. None at all is `stage.missing_model`. The validator does not check that the model id is configured on the Host; a placeholder passes.
- `pipeline.model_applies` is an informational warning on every pipeline whose model fills stages.
- **Independence** sets what happens when a turn ends without an accepted envelope. `persistent` (the default) treats a quiet turn as a continuation and reminds the stage to keep working. `strict` gives a short reminder budget and lets the stage give up with a failure envelope sooner. `open` behaves like `persistent` and also tells the stage, when an approach fails, to try another one with the tools it has. Precedence: stage, pipeline, manifest, then `persistent`.
- **timeout_ms** is the only per-attempt budget in YAML (default one hour). Raise it for long builds or test suites. There is no cost budget in pipeline YAML.

## Task file

```yaml
id: weekly-digest
goal: Produce this week's digest on the configured topic
context: Sources are public web pages; keep the digest under 500 words.
constraints: Do not send anything without operator approval.
input:
  topic: Open-source observability tools
```

| Key | Notes |
|---|---|
| `id`, `goal` | Required. |
| `context`, `constraints` | Optional free text given to every stage. |
| `input` | Object handed to the entry stage. Must satisfy its `io.input.schema`; not checked by `sf validate`. |
| `checkout` | A path string, or `{ branch, base }`. |
| `repository` + `ref` | Remote repository binding. Use `checkout` or `repository` + `ref`, never both (`task.binding_conflict`); `repository` needs `ref` (`task.repository_ref_required`). |
| `run_branch_template`, `git_identity` | Branch naming and commit identity for runs that commit. |

Unknown task keys are ignored without a finding. A pipeline with no task file still validates; the console needs a task under `catalog.tasks` to start a run from its Run list.

## Include fragments

```yaml
id: with-fragment
model: CHANGE_ME/<provider-model>
include:
  - local: ./shared-stages.yaml
stages:
  - id: publish
    system_prompt: Publish the result named in the prior payload.
    io: { input: { schema: { type: object } }, output: { schema: { type: object } } }
```

A fragment file holds a `stages:` list with the same entry shapes; `local:` paths are relative to the including file. Includes merge before the file's own stages; nesting is allowed; cycles (`pipeline.include_cycle`) and duplicate stage ids (`pipeline.include_duplicate_stage`) are errors. A fragment's top-level `model`, `agent` and `independence` are ignored. Wire included stages with `route` like any other stage.

## Legacy and rejected keys

| Key | Result | Use instead |
|---|---|---|
| `needs`, `fork`, entry-level `feedback_loop` | `pipeline.dag_error` | `route` on the source; `{ type: loop }` |
| `route_select`, `allow_none` | rejected | `if` on route entries |
| `clonable` on a pipeline entry, `clone_actions`, envelope `clone_forks` | rejected | A Clone Chain |
| `clonable` in a stage file | ignored without a finding | Remove it |
| `clone_cap` / `clone_mode` on a stage that is not a Clone Chain emitter | `pipeline.dag_error` "clone_cap is no longer supported" (the real cause is that the stage is not a valid emitter) | Build the chain correctly or remove them |
| `payload_schema`, `clone_input_schema`, `pre_emit_checks`, `completion`, `recovery` | Still read, with a `catalog.legacy_yaml` warning; mixed with `io`/`verify`/`on_verify_fail` in one file is `catalog.mixed_yaml_dialect` | `io`, `verify`, `on_verify_fail`; convert with `sf migrate-yaml <path> --write` |
