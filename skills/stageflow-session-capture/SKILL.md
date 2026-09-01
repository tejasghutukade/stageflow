---
name: stageflow-session-capture
description: >-
  Turns a coding session or pasted transcript into reusable Stageflow stages
  and a pipeline in the project catalog. Use when the user wants to capture
  this chat or a past session so the same loop can be rerun later.
compatibility: Requires Node.js >= 20 and the sf CLI on PATH
disable-model-invocation: true
---

# Stageflow session capture

Extract what happened and what worked from the current session, an explicit file, or a pasted transcript. Write stages and a pipeline into the catalog. `stageflow-run` owns throwaway tasks and starting a run.

This job talks to Stageflow through the `sf` CLI. Talking jobs cite [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md) for MCP-vs-CLI; do not run the host probe in that file from this job.

Shape reference: [`assets/example-pipeline/example.pipeline.yaml`](assets/example-pipeline/example.pipeline.yaml), [`assets/example-pipeline/research.yaml`](assets/example-pipeline/research.yaml), [`assets/example-pipeline/implement.yaml`](assets/example-pipeline/implement.yaml).

## Preconditions

**Done when** `sf` is on PATH and `stageflow.yaml` exists at the catalog root (git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory).

If either is missing, stop and name `stageflow-setup`. Do not scaffold the manifest or install the CLI here.

## Session source

Pick one mode. **Done when** you have the history you will extract from.

1. **Live context (default).** The work is already in this conversation. Draft from context. Do not read a transcript file.
2. **Explicit pointer.** The human passed `--path`, a file path, or pasted text. Use that directly. For a path, run:

   `node scripts/locate-session-transcript.mjs --path <file>`

   `{"ok":true,"source":"explicit"}` → read that path. `{"ok":false,"reason":"unreadable"}` → ask for another path or a paste.
3. **Past session, no pointer.** Run one lookup:

   `node scripts/locate-session-transcript.mjs`

   `{"ok":true}` → show `path` to the human, then extract from that file. `{"ok":false,"reason":"not_found"}` → ask the human to point at a file or paste the history.

Stores, encoding, and the point-or-paste fallback: [`references/transcript-sources.md`](references/transcript-sources.md). Do not open Cursor or OpenCode SQLite databases.

## Provider gate

Run before any catalog write:

```
node scripts/check-provider-gate.mjs
```

`--sf-bin <path>` defaults to `sf`. Stdout is JSON.

| stdout | next |
|---|---|
| `{"ok":true}` | continue |
| `{"ok":false,"reason":"no_provider_configured"}` | stop; name `stageflow-setup` |
| `{"ok":false,"reason":"sf_not_found"}` | stop; name `stageflow-setup` |

Do not run `sf providers login`.

## Extract

From the chosen source, list the phases that happened and what worked in each. Drop one-off paths, secrets, and chat noise. Keep a human-review checkpoint as prose in that stage's approach, not as a HITL gate.

**Done when** you have an ordered phase list and a one-line pipeline purpose.

## Author

Read [`references/catalog-authoring.md`](references/catalog-authoring.md) before writing.

1. Open `stageflow.yaml`. Write under a `catalog.pipelines` root (a new subdirectory is fine). If the manifest is missing or unreadable, stop and name `stageflow-setup`.
2. For the pipeline and each stage, resolve an id:

   `node scripts/resolve-catalog-id.mjs --text "<phrase>" --dir <write-dir> --kind pipeline|stage`

   Use the printed `{"id":"..."}`.
3. Write one external stage YAML per phase (`id`, `system_prompt`, `model`). End every `system_prompt` with an `emit_stage_envelope` footer. Omit `gate_kinds`. Filename stem must match `id`.
4. Write one pipeline YAML that wires the stages with `uses:` and `needs:` in dependency order.

Do not write a `*.task.yaml`.

**Done when** the pipeline file and every stage file exist on disk.

## Validate

```
sf validate --pipeline <pipeline-path> --strict
```

**Done when** the command exits 0. If it fails, delete every file this invocation wrote, report the finding, and stop.

## Report

Print the pipeline path and each stage path. Name `stageflow-run` if the human wants to execute the pipeline.
