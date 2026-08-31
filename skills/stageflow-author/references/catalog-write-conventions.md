# Catalog write conventions

Write pipeline and stage YAML with the native Write tool. `sf ui` does not need to be running. Do not call `createPipeline` or `createStage`.

## Location

Project root is the git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory.

1. **Manifest present.** Read `stageflow.yaml` at that root. Write the colocated set under a declared `catalog.pipelines` root. A new subdirectory under that root is enough — catalog scan is recursive.
2. **No manifest.** Write the colocated set as a flat layout at the project root (pipeline file and stage files beside each other).

Do not write a `*.task.yaml`.

## File shape

One directory (or the project root) holds:

| File | Required fields |
|---|---|
| `<pipeline-id>.pipeline.yaml` | `id` matching the filename stem; `stages:` object entries |
| `<stage-id>.yaml` | `id`, `system_prompt`, `model`; `gate_kinds` when the step is gated |

Each pipeline stage entry has `id` and `uses: ./<id>.yaml` (path relative to the pipeline file). Non-root stages add `needs: <parent-id>`. A deciding stage adds `fork:`. Filename stem matches `id` on every file.

## Collisions

Before writing, list `*.pipeline.yaml` files in the target directory (and existing pipeline files under the same catalog root) plus every `*.yaml` / `*.yml` stage file beside the target pipeline. Read each file's top-level `id:` and its filename stem.

On a match for the candidate pipeline id or any stage id, ask the human for a different id. Write nothing until that id is free. Never replace an existing file silently. Proceed with a colliding name only when the human explicitly confirms overwrite.
