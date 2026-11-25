# artifacts

One-stage walkthrough: opt in to **`publish_artifact`**, write a Markdown report and a CSV table, publish both with stable ids, and find them in the console and CLI.

The stage shape matches the canonical fixture [`tests/fixtures/pipelines/publish-report.pipeline.yaml`](../../tests/fixtures/pipelines/publish-report.pipeline.yaml). For a single-id example see [`tests/fixtures/pipelines/publish-note.pipeline.yaml`](../../tests/fixtures/pipelines/publish-note.pipeline.yaml).

| Stage | `artifacts` | Publishes |
|-------|-------------|-----------|
| `publish-report` | `publish: true`, `expect: [weekly-report, metrics-table]` | `static.markdown` + `static.table` |

## Prerequisites

- Node.js ≥ 20 and the Stageflow CLI (`npm run build` in this repo or `npm i -g stageflow`)
- Provider auth for `sf run` (`sf providers status`)
- Replace `CHANGE_ME/<provider-model>` in `publish-report.yaml` before running (or rely on a project default in `stageflow.yaml`)

## Validate

From the repository root:

```bash
sf validate --pipeline examples/artifacts/publish-report.pipeline.yaml --strict
sf validate --task examples/artifacts/publish-report.task.yaml
```

## Run

```bash
sf run \
  --pipeline examples/artifacts/publish-report.pipeline.yaml \
  --task examples/artifacts/publish-report.task.yaml
```

With `sf ui` running, open **Artifacts** (`#/artifacts`) and filter by owner `stage:publish-report:publish-report`. The run JSON includes `published_artifacts` when you pass `--include stages`.

## CLI

```bash
sf artifact list --owner stage:publish-report:publish-report --json
sf artifact show stage:publish-report:publish-report/weekly-report --json
sf artifact show stage:publish-report:publish-report/metrics-table --json
```

Publish by hand (same caps as the tool):

```bash
printf '# Demo\n' > /tmp/weekly-report.md
sf artifact publish \
  --owner stage:publish-report:publish-report \
  --id manual-note \
  --kind static.markdown \
  --title 'Manual note' \
  --file /tmp/weekly-report.md

sf artifact delete stage:publish-report:publish-report/manual-note
```

Search:

```bash
sf artifact list --q weekly --json
```

`sf artifact read --run <runId> --path weekly-report.md` reads the run workspace file; it does not use the index.

## MCP

With `toolsets=artifacts` on the Host MCP URL:

- `get_artifact` with `list: true` and `owner: stage:publish-report:publish-report`
- `get_artifact` with `key: stage:publish-report:publish-report/weekly-report` and `view: content`

## Agent snippet

Agents publish when granted `artifacts.write` (model tool `publish_artifact`). Example grant:

```yaml
tools:
  builtin: [read, write]
  stageflow:
    groups: [artifacts.read, artifacts.write]
approvals:
  ask_first: [publish_artifact, stageflow.get_artifact]
```

The Host MCP tool `save_artifact` is for operators choosing an owner; agent sessions do not receive it.

## Docs

- [Artifacts](../../docs/artifacts.md) — index, publish, CLI, MCP
- [Authoring artifacts](../../docs/artifacts.md#authoring-artifacts) — when to publish versus envelope list
- [Stage artifacts](../../docs/yaml-catalog.md#stage-artifacts) — YAML field