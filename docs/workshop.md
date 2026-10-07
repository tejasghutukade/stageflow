---
layout: default
title: Workshop Author
---

# Workshop Author

Workshop is the console surface for designing a pipeline in chat. The agent asks when a missing detail would change the stages or the wiring, then edits the draft. The studio map shows the stages. Save writes catalog YAML, and Run lists the saved pipeline and task.

Open it with `sf ui` (default `http://127.0.0.1:3847`) and choose **Workshop** in the rail, or go to `#/workshop`. There is no separate `sf workshop` command.

## Chat and the studio

Describe the workflow in your own words. The Author asks one specific question when a missing detail would change the stages, the wiring, the goal, or a gate. When the request is already specific, it creates and edits the pipeline, stages, and an optional task on the draft. The map updates as stages are added.

Click a stage for a read-only summary: prompt, IO, verify, and HITL. Close it with Escape or the scrim.

Accept confirms a mutation. Reject undoes that mutation when the draft has not changed since. Reject does not undo a save that already wrote files.

## Drafts and chat history

Untitled work is a **build**: `$STAGEFLOW_HOME/workshop/builds/{id}.json` (default `~/.stageflow/workshop/builds/{id}.json`). The file holds the draft package.

Chat history is separate: `$STAGEFLOW_HOME/workshop/sessions/<sessionId>/session.json` (transcript, title, timestamps, and the Pi session id). The session stores `activeBuildId`, the build it was editing. It does not embed the draft.

The studio picker lists open builds and on-disk pipelines. History reopens the session and the build that session points at. **New** starts a fresh greeting.

## Model

A new Workshop chat selects its model in this order:

1. The top-level `model` in the project `stageflow.yaml`
2. The Workshop model saved in Settings, when the manifest has none
3. `cursor/auto`

The composer can override the model for the current session. That choice is the chat model. Stage YAML can still name a different model.

`cursor/auto` needs the Cursor Pi extension (`pi-cursor-sdk`) and a Cursor API key (Pi login or `CURSOR_API_KEY`). See [Providers](providers.md).

## Save and Run

Save writes catalog files only when you ask. If you do not name a folder, the package lands in `workshop/<pipeline-id>/` in the project. Stageflow adds `workshop` to `catalog.pipelines` and `catalog.tasks` in `stageflow.yaml` when that root is missing, so **Pipelines**, **Tasks**, and **Start a run** list the files.

If you name a folder, the package is written there, and that folder is added to the catalog when it is not already covered.

`sf init` already lists `workshop` under both pipelines and tasks. The `workshop/` directory is created on the first save.

`sf ui` registers the directory it was started in, so that project's catalog is visible in the console. Start `sf ui` from the project root.

Run the saved paths from **Start a run**, or:

```bash
sf run \
  --pipeline workshop/<pipeline-id>/<id>.pipeline.yaml \
  --task workshop/<pipeline-id>/<id>.task.yaml
```

## What stays out of the catalog

Builds and sessions live under `$STAGEFLOW_HOME`. They are not catalog files. A refresh keeps an untitled build because it is on disk. See [Data directory](data-directory.md) and [Operator console](operator-console.md#workshop).
