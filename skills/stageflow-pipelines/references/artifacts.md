# Published artifacts

How a stage opts in to `publish_artifact`, when to publish versus list paths on the envelope, and how that differs from run-file indexing and function grants.

## Contents

- [Three meanings of artifact](#three-meanings-of-artifact)
- [Stage YAML](#stage-yaml)
- [The publish_artifact tool](#the-publish_artifact-tool)
- [Kinds and ids](#kinds-and-ids)
- [When to publish versus envelope list](#when-to-publish-versus-envelope-list)
- [Errors](#errors)

## Three meanings of artifact

| Meaning | Where | What happens |
|---|---|---|
| Envelope `artifacts` | Success `emit_stage_envelope` | Host **indexes** each path as `origin: indexed`; bytes stay in the run workspace and follow retention. |
| `publish_artifact` | Opt-in stage or agent | Copies into `$STAGEFLOW_HOME/artifacts/`; **versions**; survives run delete. |
| Function `access.artifacts` | Function YAML | Read grant for run files inside a function call. Not the index. |

## Stage YAML

On the **stage body** only (file or inline entry):

```yaml
artifacts:
  publish: true
  expect: [weekly-report]
```

| Key | Rule |
|---|---|
| `publish` | `true` registers `publish_artifact` and appends a prompt section. Omitted or `false`: byte-identical to today. |
| `expect` | Optional list of ids this attempt must publish before success emit. Max 20 unique slugs. Without `publish: true` → `stage.invalid_artifacts`. |

Validate with `sf validate`. Authoring reference: [YAML catalog — Stage artifacts](../../../docs/yaml-catalog.md#stage-artifacts).

## The publish_artifact tool

Parameters: `id`, `kind`, `title`, optional `description`, `tags`, `summary`, and one of `path`, `content`, or `content_base64`.

- Stage `path` must be inside this attempt's `artifacts/` directory (use `write_stage_artifact` first).
- Does not finish the stage; still call `emit_stage_envelope`.
- Same `id` again → version N+1. Identical bytes and kind → `unchanged: true` (title, tags, summary may still update).
- Text kinds (not `static.image`): UTF-8 required; content is secret-scrubbed before store.
- `static.html`: stored as given; console renders sandboxed HTML without scripts in the preview.

## Kinds and ids

| Kind | Use |
|---|---|
| `static.markdown` | `.md` reports, README-style output |
| `static.table` | CSV or JSON array of objects |
| `static.text` | Other UTF-8 text |
| `static.image` | png, jpeg, gif, webp |
| `static.html` | Single HTML document (sandboxed preview; no remote loads in console) |

Id: `^[a-z][a-z0-9_-]{0,63}$`. No `::`. Title ≤ 120 chars. Tags ≤ 8, each `[a-z0-9_-]{1,32}`. Content ≤ 5 MiB.

Use `title`, `description`, `tags`, and `summary` so the Artifacts page search and `sf artifact list --q` can find the deliverable.

## When to publish versus envelope list

| Goal | Mechanism |
|---|---|
| Hand a file to the next stage or show it on the run | `write_stage_artifact`, list path on envelope `artifacts` |
| Long-lived deliverable, search, versions, agent read across sessions | `artifacts: { publish: true }` and `publish_artifact` |
| Contract that the stage must publish specific ids | Add `expect: [id, …]` |

Envelope listing alone does not copy bytes to the keep store. Publishing does not replace listing when a verify `type: artifact` check needs a run file on disk.

## Errors

| Code | Fix |
|---|---|
| `stage.invalid_artifacts` | Fix the `artifacts` block shape, ids, or add `publish: true` when using `expect`. |
| `artifact.expected_missing` | Call `publish_artifact` for each id in `expect` before success emit. |
| `artifact.invalid_id` / `artifact.invalid_kind` / `artifact.invalid_shape` | Fix slug, kind, UTF-8, tags, or table shape. |
| `artifact.too_large` | Keep under 5 MiB or split content. |

Operator listing and MCP: `stageflow-operate` skill `references/artifacts.md`. Agent grants: `stageflow-agents` skill `references/tools-and-approvals.md`. Runnable walkthrough: `examples/artifacts/` in the Stageflow repo.