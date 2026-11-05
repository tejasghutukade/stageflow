# Authoring tools

Two ways to write a package. Both end at the same validator. Prefer editing files when the package already exists. Use the MCP author tools to create a new package when the Host is this project.

## Contents

- [Which path](#which-path)
- [MCP author tools](#mcp-author-tools)
- [Validate](#validate)
- [Traps](#traps)

## Which path

Call `get_started` when the harness has Stageflow MCP. The seven tools below write under the Host project (`projectRoot`, else the directory the Host was started in) and have no `project_root` argument. Use them only when both are true:

- `get_started` lists a `catalog_roots` entry with `kind: "registered"` whose `project_root` is this project's absolute path.
- `read_pipeline` on a pipeline file in this project returns that package. If it cannot see a file you know is here, the Host is pointed at another directory. Write files instead.

A `kind: "workspace"` root is `$STAGEFLOW_HOME/workspace` (wire id `workspace`). It is not this project. Do not treat it as the write target.

Write files directly, from the project root, in every other case. That includes repairs: the edit tools re-serialize YAML (comments are lost) and merge objects, so they cannot delete a key.

MCP `create_pipeline` also registers the folder in `stageflow.yaml` `catalog.pipelines` and `catalog.tasks` when the manifest exists and those keys are already lists. A folder under `workshop/` or `pipelines/` is covered by that one root. A direct write does not register anything; add the directory yourself when it is not already under a root.

## MCP author tools

Paths are relative to the Host project, with forward slashes, such as `pipelines/release/release.pipeline.yaml`. Each mutation validates with strict mode before writing. Nothing is written when validation fails unless `allow_invalid` is true. A failure returns `{ error, status }`. 422 is the validation failure: `error` is the first error message only, and the findings list is omitted. 409 means the file exists (`edit_pipeline`). 400 is a bad argument. Run `sf validate` to see every finding. Pass `allow_invalid: true` only while assembling a package that cannot validate yet, then remove it and validate.

Always pass `model`. If you omit it, the tool writes the Host's last resolved default, or `openrouter/nvidia/nemotron-3.5-lightning:free` when none has been resolved. That string is not evidence the model is configured. Prefer an id from `list_models`, or `CHANGE_ME/<provider-model>`.

| Tool | Parameters | What it writes |
|---|---|---|
| `read_pipeline` | `path`, optional `task_path` | Nothing. Returns `{ draft, destination, validation }`. Call it before an edit. |
| `create_pipeline` | `directory`, `id`, optional `model`, `agent`, `stages`, `pipeline`, `allow_invalid` | `<directory>/<id>.pipeline.yaml`. Fails if that file exists. `pipeline` is a whole pipeline object instead of `id` / `model` / `stages`. The first stage gets `entry: true` when none has it. A pipeline with no stages does not validate; pass `stages` or `allow_invalid`, then `create_stage`. |
| `edit_pipeline` | `path`, `patch`, optional `allow_invalid` | Copies `id`, `model`, `agent`, `stages`, `schemas`, `requires`, `memories` and `channels` from `patch` when present. `memories: []` and `channels: []` remove those two fields. A `stages` patch that adds or drops a stage body is refused: use `create_stage` or `edit_stage`. |
| `create_stage` | `path`, optional `id`, `summary`, `system_prompt`, `model`, `entry`, `route`, `io`, `body`, `allow_invalid` | Adds `uses: ./<id>.yaml` and a stage file with `id`, `system_prompt`, `model` and object `io` schemas. Pass `id` (kebab case) and `system_prompt`. Omitting `id` slugifies `summary` (lowercase, non-alphanumerics to `-`, 40 characters) and can start with a digit. `body` is extra stage-file fields (`skill`, `gate_kinds`, `verify`, `secrets`, `browser`, `mcp`, `channels`). `route` and `entry` go on the pipeline entry. The first stage is `entry: true`. |
| `edit_stage` | `path`, `id`, optional `patch`, `body`, `pipeline_entry`, `entry`, `route`, `uses`, `system_prompt`, `model`, `io`, `allow_invalid` | Merges `patch` and `body` onto the stage file, and `entry`, `route`, `uses` and `pipeline_entry` onto the pipeline entry. Omitted keys stay. There is no way to delete a key. |
| `create_task` | `path`, optional `id`, `goal`, `filename`, `body`, `allow_invalid` | Creates or replaces the task on that package. Default filename is `<id>.task.yaml`. `body` is the task object; `id` and `goal` are filled in when missing. |
| `edit_task` | `path`, `task_path`, optional `id`, `goal`, `patch`, `body`, `allow_invalid` | Merges `patch` and `body` onto the task. Fails with "no task on draft" until `create_task`. |

`create_stage_file` and `create_task_file` are different tools. They reject an id that is not kebab case. `create_pipeline`, `create_stage` and `create_task` do not. `write_catalog_file` overwrites an existing stage file and restores it if the new text is not valid stage YAML. `validate_catalog_draft` validates a draft and writes nothing.

## Validate

Run from the project root so `stageflow.yaml`, `.mcp.json` and the secret registry resolve.

```
sf validate --pipeline <pipeline-path> --strict --json
sf validate --task <task-path> --json
sf validate --trigger <trigger-path> --json
```

Use at most one of `--pipeline`, `--task` and `--trigger`. There is no flag that checks a task against a pipeline; the self-check script does that.

Exit 0 means no errors. Warnings are allowed. Exit 1 means at least one error. The JSON object is `{ ok, scope, checks, summary: { errors, warnings }, findings: [{ severity, category, code, file, message }] }`. `checks` is a single sentence, not a list of check names. Look up `code` in [finding-codes.md](finding-codes.md).

`--strict` promotes `catalog.manifest_missing`, `catalog.empty_catalog` and eval warnings to errors. A `--pipeline` run does not read catalog roots, so those two catalog codes do not appear and `--strict` changes nothing on a normal pipeline. Still pass it: the skill's repair loop is strict, and a later full-catalog validate will be too.

`--project-root` on `sf validate` accepts an absolute path or the id `workspace`. A short registered name fails with `Unknown project_root`. Run in the project directory instead.

Related commands, same `--pipeline` path:

- `sf graph --pipeline <path>` prints the resolved DAG. `--json` dumps it. MCP `describe_pipeline` takes `{ pipeline }` and labels edges with the legacy words needs, fork and feedback_loop. Translate those. Do not copy them into YAML.
- `sf doctor --pipeline <path> --json` checks `requires`, secrets, `mcp` and channels. It does not call a model. MCP `preflight` takes `{ pipeline, strict? }`.
- `sf migrate-yaml <path> --json` is a dry run. `--write` converts legacy contract keys. Ask before `--write`.

Validation never calls a model and never starts a run.

## Traps

- Unknown keys in a stage file, at the pipeline top level and in a task are ignored. A typo such as `gate_kind` or `verfy` drops the field with no finding. Run `scripts/check-catalog-keys.mjs` before validate.
- Task `input` is not compared to the entry `io.input` until run start (`task.invalid_shape`). The declared code `task.entry_input_unmet` is never emitted. The self-check script reports `lint.task_input_mismatch`.
- Ids are not format-checked by `sf validate`.
- `create_pipeline` and `create_stage` invent a model when `model` is omitted. Pass one.
- `create_stage` writes `model` on the stage body, so the stage no longer inherits a later pipeline model change. Omit `model` from `body` only if you also accept the invented default. To inherit, write the stage file yourself and leave `model` off the stage.
- Edit tools cannot delete a key. A successful edit rewrites the whole package through the publisher, so comments disappear from the pipeline and every stage file, not only the one you changed. For a deletion or a comment-preserving edit, change the file.
- A 422 from an author tool is one message. Validate to see every finding.
- `describe_pipeline` output is not authoring YAML.
- `sf providers status` has no `--json`. A provider is usable when a tab-separated row's second field is `configured`. `scripts/check-provider-gate.mjs` prints `{"ok":true}` or `{"ok":false,"reason":"no_provider_configured"}`.
