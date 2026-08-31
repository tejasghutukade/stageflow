# Catalog authoring

Write pipeline and stage YAML with the native Write tool. Confirm with `sf validate --pipeline <path> --strict`. Do not call `createPipeline` / `createStage` or any MCP catalog-write tool. `stageflow-author` is expected to follow this same shape; this file does not define that skill.

## Catalog roots

Read `stageflow.yaml` at the project root (git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory). Write new files under a declared `catalog.pipelines` root. A new subdirectory under an existing root is enough — catalog scan is recursive. If the manifest is missing or unreadable, stop and name `stageflow-setup`. Do not scaffold the manifest.

Resolve collision-safe ids with `scripts/resolve-catalog-id.mjs` (`--text`, `--dir` = the write directory, `--kind pipeline|stage`). Print is `{"id":"..."}`.

## External stage file

Required fields: `id`, `system_prompt`, `model`. Filename stem must match `id` (`research.yaml` → `id: research`).

Every `system_prompt` ends with a mandatory `emit_stage_envelope` footer, for example:

```
When finished, call emit_stage_envelope once with status, summary, artifacts,
and a payload the next stage can use.
```

Omit `gate_kinds`. A human-review checkpoint from the source session stays as prose in the stage approach, not a HITL gate.

Worked example: `assets/example-pipeline/research.yaml` and `assets/example-pipeline/implement.yaml`.

## Pipeline file

`id` plus `stages:` entries with `id`, `uses:` (path relative to the pipeline file), and `needs:` for every non-root stage. Linear chain: each stage `needs` the previous id.

Worked example: `assets/example-pipeline/example.pipeline.yaml`.

Write stages and the pipeline only. `stageflow-run` owns the throwaway task at run time.

## Validate

```
sf validate --pipeline <pipeline-path> --strict
```

On failure, delete the files this invocation wrote and report the finding. Do not leave a half-written catalog.
