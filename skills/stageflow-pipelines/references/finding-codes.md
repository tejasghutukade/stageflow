# Finding codes

How to repair a finding from `scripts/check-catalog-keys.mjs` or `sf validate`. Fix `stage.*` before the `pipeline.missing_stage` that comes with a stage file that failed to load. Then re-run the self-check and validate. Exit 0 with only warnings is a finished repair. `pipeline.model_applies` is informational and appears on every pipeline that sets a model.

## Contents

- [What validation does not catch](#what-validation-does-not-catch)
- [Self-check codes](#self-check-codes)
- [Pipeline and stage codes](#pipeline-and-stage-codes)
- [Catalog, task and trigger codes](#catalog-task-and-trigger-codes)

## What validation does not catch

`sf validate` can return `ok: true` for a package that will fail at run start or that silently dropped a field. Run `node scripts/check-catalog-keys.mjs --pipeline <path> [--task <path>]` first. Exit 1 is a lint error with `{ ok, summary, findings }`. Exit 2 with `reason: yaml_parser_unavailable` means compare every key to [yaml-reference.md](yaml-reference.md) by hand.

| Blind spot | What happens | What to do |
|---|---|---|
| Unknown key in a stage file (`gate_kind`, `verfy`, `description`, `clonable`) | Ignored. No finding. A typo drops the gate or the check. | `lint.unknown_stage_key`. Rename to a real body key or delete it. |
| Unknown pipeline top-level key, including `browser` | Ignored. A pipeline-level `browser` configures no stage. | `lint.unknown_pipeline_key` or `lint.pipeline_browser_ignored`. Move `browser` onto each stage. |
| Unknown task key | Ignored. | `lint.unknown_task_key`. |
| Task `input` does not satisfy the entry stage's `io.input.schema` | Not checked. Run start fails with `task.invalid_shape` ("Task input does not match entry stage …"). Omitted `input` is `{}`. | `lint.task_input_mismatch`. Supply every required field, or loosen the entry input. |
| Id is not kebab case | `sf validate` accepts `Stage_A`. | `lint.id_format`. Rename to `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`. |
| `checkout_context: true` and the task binds no checkout | Run start only: `stage.checkout_context_unbound`. | Bind `checkout`, or `repository` plus `ref`. |
| Tool, secret value, MCP connect, channel connection | Names and shapes only. | `sf doctor --pipeline <path> --json` or MCP `preflight`. |

`task.entry_input_unmet` is declared and never emitted. Do not look for it. The run-start code is `task.invalid_shape`. `catalog.path_case_mismatch` is declared and its checker is never called, so a `uses` path that differs only in letter case produces no finding. Match the filename on disk anyway.

## Self-check codes

These come from `scripts/check-catalog-keys.mjs`, not from `sf validate`.

| Code | Severity | Fix |
|---|---|---|
| `lint.unknown_stage_key` | error | The message names the key and a likely real key. Use that key, spelled as in [yaml-reference.md](yaml-reference.md). |
| `lint.unknown_pipeline_key` | error | Remove it or move it to the stage or task where it belongs. |
| `lint.unknown_fragment_key` | error | A fragment may only have `stages`, `include`, `model`, `agent` and `independence`. |
| `lint.unknown_task_key` | error | Remove it. Task keys are `id`, `goal`, `context`, `constraints`, `input`, `checkout`, `repository`, `ref`, `run_branch_template` and `git_identity`. |
| `lint.id_format` | error | Lowercase kebab case on the pipeline, stage and task ids. |
| `lint.pipeline_id_filename` | warning | Make the pipeline `id` match the filename stem, or rename the file. |
| `lint.pipeline_browser_ignored` | warning | Put `browser` on the stage file or the `uses:` wrapper. |
| `lint.task_goal_missing` | error | Set a non-empty `goal`. |
| `lint.task_input_shape` | error | `input` must be a mapping. |
| `lint.task_input_mismatch` | error | Make `input` satisfy every entry stage's `io.input.schema`. |
| `lint.unreadable` | error | The path is missing or unreadable. |
| `lint.yaml_parse` | error | Fix the YAML syntax the message quotes. |
| `lint.not_a_mapping` | error | The file's top level must be a mapping. |

## Pipeline and stage codes

| Code | Severity | Typical cause | Fix |
|---|---|---|---|
| `pipeline.model_applies` | warning | The pipeline model fills stages. | Leave it. |
| `pipeline.route_all_gated` | warning | Every forward route has `if`. | Fine when the conditions cover every value. Otherwise add one ungated route. |
| `pipeline.dag_error` | error | No `entry: true` once any stage has `route`; `needs`, `fork` or an entry-level `feedback_loop`; `clonable`; unknown or duplicate `to`; a forward cycle; `clone_cap` on a stage that is not a Clone Chain emitter. | Mark a root `entry: true`. Wire with `route` on the source. Use `{ type: loop }` for a back-edge. The "clone_cap is no longer supported" text also means this stage is not a valid emitter: build the chain or remove `clone_cap` and `clone_mode`. |
| `pipeline.invalid_shape` | error | Unknown key on a stage entry, such as `memories` on a stage. | Move it to the pipeline or the stage file, or remove it. |
| `pipeline.stage_uses_inline_conflict` | error | A body key other than `mcp`, `secrets`, `requires` or `browser` sits beside `uses:`. | Move `system_prompt`, `channels`, `io`, `verify`, `gate_kinds` and `skill` into the stage file. |
| `pipeline.stage_wrapper_skill_rejected` | error | `skill` beside `uses:`. | Put `skill` in the stage file. |
| `pipeline.stage_missing_body` | error | The entry has neither `uses` nor an inline body. | Add `uses: ./<id>.yaml` or inline the body. |
| `pipeline.missing_stage` | error | The `uses:` file is missing or failed to load. | Fix the paired `stage.*` finding first. |
| `pipeline.stage_id_mismatch` | error | The stage file's `id` differs from the entry `id`. | Make the entry id, the file id and the filename stem the same. |
| `pipeline.include_duplicate_stage` | error | The same stage id appears twice, including across `include`. | Rename one. |
| `pipeline.include_cycle` | error | An `include` `local` path eventually includes itself. | Break the cycle. |
| `pipeline.include_invalid` | error | `include` is not a list of `{ local: ./file.yaml }`. | Fix the path. It is relative to the including file. |
| `pipeline.io_incompatible` | error | A child's required input is missing or a different type on some parent output. | Add the field as required on every parent, or loosen the child input. Shared `schemas` plus `$ref` avoid this. |
| `pipeline.route_if_invalid` | error | `field` is not required on the producer output; the op is not supported (`exists` is not an op); `if` is on a loop entry. | Require the field. Use `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` or `not_in`. Remove `if` from `{ type: loop }`. |
| `pipeline.invalid_completion` | error | A gate `kind` is not in `gate_kinds`, or a `checkout_changes` `path_fields` entry is not a required string array. | Add the kind to `gate_kinds`. Declare the field as a required array of strings. |
| `pipeline.invalid_verify` | error | `artifact` without `when`, or a bad verify type or field. | Set `when`. See the verify table in [yaml-reference.md](yaml-reference.md#verify-items). |
| `pipeline.invalid_recovery` | error | `on_verify_fail` with no after-phase verify, or `repair` without `retry_safety: idempotent` and `max_attempts`. | Add an after-phase verify. Use `manual` and `side_effecting` for send, publish or push. |
| `pipeline.invalid_requires` | error | `requires` is not a list of `{ tool, version? }`. | Fix the shape. |
| `pipeline.requires_conflict` | error | Pipeline and stage version ranges for one tool do not overlap. | Use one range that both can satisfy. |
| `pipeline.invalid_channels` | error | The pipeline `channels` list is not one `{ connection, to, operations: [send] }` entry. | Fix the shape, or move the channel onto the stage. |
| `pipeline.invalid_memories` | error | Not a list of memory ids, a bad id, or a duplicate. | One id per memory, matching `^[a-z][a-z0-9_-]{0,63}$`. |
| `pipeline.memory_unavailable` | error | The id does not exist on this Host. | Create it in the console, or remove it. |
| `pipeline.invalid_agent` | error | `agent` is not `pi` or `claude`. | Use one of those, or omit it. |
| `pipeline.invalid_model` | error | `model` is not a non-empty string. | Set a real id or `CHANGE_ME/<provider-model>`. |
| `pipeline.invalid_independence` | error | Not `strict`, `persistent` or `open`. | Use one of those, or omit it. |
| `pipeline.load_error` | error | The pipeline file did not parse or could not be read. | Fix the syntax or the path. |
| `pipeline.string_stage_ref` | error | A stage entry is a bare string. | Use a mapping with `id` and `uses` or an inline body. |
| `stage.invalid_io` | error | Missing `io.input.schema` or `io.output.schema`, an array without `items`, or a node without `type` (`oneOf` and `anyOf` are not supported). Legacy `payload_schema` without `clone_input_schema` also lands here. | Author both schemas with object roots. |
| `stage.invalid_shape` | error | A wiring key (`route`, `entry`, `on_verify_fail`, `clone_cap`) is in a stage file. | Move it to the pipeline entry. |
| `stage.missing_model` | error | No model on the stage, the pipeline or `stageflow.yaml`. | Set the pipeline `model`. |
| `stage.invalid_model` | error | The stage `model` is not a non-empty string. | Fix the string. The validator does not check that the id is configured. |
| `stage.invalid_gate_kinds` | error | A kind other than `confirm`, `free_text`, `artifact_backed` or `multi_question`. | Use one of those four. |
| `stage.invalid_channels` | error | More than one channel, or a bad channel object. | One channel. Split the stage if you need two. |
| `stage.channel_unavailable` | error | The connection is missing, disabled, or the target is invalid for that provider. | Fix the connection in `stageflow-operate`, or the `to` value. |
| `stage.invalid_browser` | error | A forbidden key (`path`, `scope`, `secret`, launch options) or a bad `check`. | Use only `profile`, `headed`, `allow_domains`, `login_url` and `check`. |
| `stage.invalid_secrets` | error | Not a list of names or `{ name, as: env }`, or a duplicate. | Fix the list. |
| `stage.unknown_secret` | error | The name is not in the Host secret registry. | Register it, or fix the spelling. `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` are always known. |
| `stage.denied_secret` | error | `STAGEFLOW_CONTROL_TOKEN` or a `STAGEFLOW_CONTROL_TOKEN_` name. | Remove it. It cannot be granted. |
| `stage.invalid_skill` | error | `skill` is empty or not a string. | One skill name. |
| `stage.invalid_mcp` | error | `mcp` is not a list of non-empty names, has a duplicate, or names `stageflow`. | Fix the list. A missing server is `catalog.invalid_mcp`. |
| `stage.invalid_requires` | error | Bad `requires` shape on the stage. | `{ tool, version? }` only. |
| `stage.invalid_independence` | error | Not `strict`, `persistent` or `open`. | Fix or omit. |
| `stage.invalid_checkout_context` | error | Not a boolean. | `true` or omit. |
| `stage.checkout_context_unbound` | error | Run start only. The flag is true and the task has no checkout binding. | Bind the task, or remove the flag. |
| `stage.invalid_timeout_ms` | error | Not a positive integer. | Milliseconds, or omit (default one hour). |
| `stage.id_filename_mismatch` | error | The file's `id` differs from its stem. | Rename the file or the id. |
| `stage.unresolved_schema_ref` | error | `$ref` does not name a pipeline `schemas` entry. | Add the schema, or inline it. |
| `stage.load_error` | error | The stage file did not parse or could not be read. | Fix the syntax or the `uses` path. |
| `stage.invalid_payload_schema` | error | Legacy `payload_schema` is not a valid object schema. | `sf migrate-yaml <path> --json`, then `--write` after the user agrees. Author `io.output.schema`. |
| `stage.invalid_clone_input_schema` | error | Legacy `clone_input_schema` is not a valid object schema. | `sf migrate-yaml <path> --json`, then `--write`. Author `io.input.schema`. |
| `stage.invalid_clone_actions` | error | Legacy `clone_actions` on a stage. | `sf migrate-yaml <path> --json`, then `--write`. Use a Clone Chain. |
| `stage.invalid_pre_emit_checks` | error | Legacy `pre_emit_checks` is malformed. | `sf migrate-yaml <path> --json`, then `--write`. Author `verify`. |
| `stage.invalid_agent` | error | Stage `agent` is not `pi` or `claude`. | Use `pi` or `claude`, or omit it. The stage `agent` does not select the backend. A value of `claude` can still reject run start when the process is root (`claude_as_root`), even if the pipeline backend is `pi`. Set `agent` on the pipeline. |

## Catalog, task and trigger codes

| Code | Severity | Typical cause | Fix |
|---|---|---|---|
| `catalog.invalid_mcp` | error | `.mcp.json` is missing or invalid while a stage lists `mcp`, or a listed name is unknown. | Add the server under `mcpServers`, or drop the name. |
| `catalog.mcp_command_missing` | error | A catalog server's `command` is not on `PATH`. | Install the binary or fix `command`. |
| `catalog.mixed_yaml_dialect` | error | Legacy keys and `io` / `verify` / `on_verify_fail` in one file. | One dialect. `sf migrate-yaml <path> --json`, then `--write` after the user agrees. |
| `catalog.legacy_yaml` | warning | Legacy contract keys only. | `sf migrate-yaml <path> --write` when the user wants the author dialect. |
| `catalog.manifest_missing` | warning | No `stageflow.yaml`. Error under `sf validate --strict` with no `--pipeline`, `--task` or `--trigger`. | `sf init` (ask first) or add a manifest. Pipeline-scoped validate does not emit this. |
| `catalog.empty_catalog` | warning | Catalog roots are empty. Same `--strict` promotion as `catalog.manifest_missing`. | Add roots. |
| `catalog.manifest_invalid` | error | `stageflow.yaml` is present and invalid. | Fix the manifest. |
| `catalog.manifest_load_error` | error | `stageflow.yaml` failed to parse or could not be read. | Fix the YAML syntax or the path. |
| `catalog.stageflow_home_absolute_path` | error | A stage text contains an absolute path under `STAGEFLOW_HOME`. | Use `STAGEFLOW_CHECKOUT` or `STAGEFLOW_RUN_WORKSPACE` instead of a path under `STAGEFLOW_HOME`. |
| `catalog.duplicate_pipeline_id` | error | Two pipelines share an id. | Rename one. |
| `task.binding_conflict` | error | Both `checkout` and `repository`. | Keep one. |
| `task.repository_ref_required` | error | `repository` without `ref`. | Add `ref`. |
| `task.ref_without_repository` | error | `ref` without `repository`. | Add `repository` or remove `ref`. |
| `task.repository_invalid` | error | `repository` is not `owner/repo`. | Fix the shape. |
| `task.invalid_shape` | error | Missing `id` or `goal`, or, at run start, `input` does not match the entry schema. | Set `id` and `goal`. For input, follow `lint.task_input_mismatch`. |
| `task.load_error` | error | The task file did not parse. | Fix the YAML. |
| `trigger.invalid_shape` | error | Missing or bad `id`, `pipeline`, `kind` or `enabled`, or `task` is not a string. | See [capabilities.md](capabilities.md#triggers). |
| `trigger.unknown_pipeline` | error | `pipeline` is not a catalog pipeline id. | Use the pipeline's `id`. Validate from the project root so the catalog is visible. |
| `trigger.unknown_task` | error | `task` is not a catalog task id. | Fix the id, or omit `task` for dynamic mode. |
| `trigger.github_action_required` | error | `event.source` starts with `github.` and `match.action` is missing. | Set `action` to `opened`, `synchronize`, `updated`, `merged` or `closed`. |
| `trigger.invalid_github_action` | error | `action` is not one of those five. | Use one of them. |
| `trigger.invalid_secret_ref` | error | `store:` is followed by a bad name. | Letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 200 characters. Never a secret value. |
| `trigger.load_error` | error | The trigger file did not parse. | Fix the YAML. |
