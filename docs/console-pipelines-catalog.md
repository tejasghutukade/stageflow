---
layout: default
title: Console - Pipelines, tasks and catalog
---

# Pipelines, tasks, catalog, triggers and the Workshop

## Pipelines (`#/pipelines`)

Lists the pipeline files in the project catalog. Selecting a row shows an inspector with **Start a run** and **Open in Workshop**. Opening a row (**Enter**, or `#/pipelines/<id>`) opens it in the **pipeline editor**.

- **New pipeline** (**N**) starts a new pipeline in the Workshop. There is no separate "draft" button.
- **Open in Workshop** (**W**, row button) opens the selected pipeline in the Workshop to change it by chat.
- **S** starts a run of the selected pipeline; **/** focuses search.
- Pinned pipelines appear in the rail.

### Pipeline editor

Graph of the stages on the left, inspector on the right, YAML panel and a Problems panel (validation findings, with quick fixes) below. **⌘S** saves, **A** adds a stage, **⌥⇧F** formats the YAML, **⌘.** applies a quick fix. Tabs: **Editor**, **Runs** (this pipeline's runs) and **History** (saved versions).

#### Stage channels

Selecting a stage shows a **Channels** section in the inspector. Pick a connection from the Connections list, enter the recipient (fields match the provider: several addresses and Cc for AgentMail, a channel id for Slack, a chat id for Telegram, a phone or email for iMessage, a phone plus an optional template for WhatsApp), and the editor writes `channels:` onto the stage. It shows the connection's status, flags a recipient the provider would reject as you type, and hides **Add channel** once the stage has its one allowed channel. A pipeline-level default `channels:` is edited in the YAML panel and survives saves. See [Communication channels](channels.md#quick-start).

## Tasks (`#/tasks`)

Task files with their last run. **N** creates a task, **E** edits, **S** starts a run, **Enter** opens the last run.

## Catalog (`#/catalog`)

Two tabs: **Stages** (stage files; **E** opens one in the editor, **N** creates one) and **Skills** (installed skills and which stages use them; **I** installs one, **C** copies a name). `#/skills` opens the Skills tab.

## Triggers (`#/triggers`)

Catalog triggers: **N** creates one, **F** fires it once, **E** enables or disables it. Email triggers need a connected [email account](email-accounts.md).

## Workshop (`#/workshop`)

The interactive authoring surface for pipelines; see [Workshop Author](workshop.md) and the section below.

### How it works

Workshop (`#/workshop`) is the interactive authoring surface. Chat turns go to **`POST /api/workshop/chat`**, which uses an **AgentPort** with the Workshop Author profile (baked playbook, draft tools, docs retrieval). A stage run uses **StagePort** instead. AgentPort stays up and answers messages; Workshop is the first caller, and a later scout or researcher would use the same port.

The Author clarifies intent, then creates and edits. Create and edit tools mutate the in-memory draft immediately, so the studio updates before Accept. Accept confirms. Reject soft-undos that mutation when the draft fingerprint is unchanged. Soft undo does not reverse a successful save. Disk writes happen only when you ask the agent to save (validate, then write).

Click a stage on the map for a read-only summary: prompt, IO, verify, and HITL.

Untitled drafts are builds under `$STAGEFLOW_HOME/workshop/builds/{id}.json`. Chat sessions (History / New) live under `$STAGEFLOW_HOME/workshop/sessions/` and store `activeBuildId`, the build that session was editing. The session blob does not embed the draft. The studio picker lists open builds and on-disk pipelines. History reopens the session and its pinned build. See [Workshop Author](workshop.md) and [Data directory](data-directory.md).

The UI prefers an NDJSON stream (`Accept: application/x-ndjson`) for progressive assistant text; otherwise it uses a coherent JSON turn.

A new chat selects its model from the project `stageflow.yaml` `model`, then the Workshop model saved in Settings, then `cursor/auto`. The composer can override that choice for the current session. See [Workshop Author — Model](workshop.md#model).

#### Manual path

From the repo (or a consumer checkout with Stageflow):

```bash
STAGEFLOW_HOME=$PWD/.stageflow-home npm run dev -- ui
```

Open the console URL, then navigate to **`#/workshop`**. New starts a fresh greeting. Chat until the map matches the workflow, then ask the agent to save. A save that does not name a folder writes `workshop/<pipeline-id>/` and adds `workshop` to the catalog, so the pipeline and task show up under **Start a run**. History restores the session and the build it was editing.

Dev without a global install uses the same entrypoint (`npm run dev -- ui`). Prefer an isolated `STAGEFLOW_HOME` so builds, sessions, and settings do not touch your real `~/.stageflow`. `sf ui` registers the directory it was started in, so that project's catalog is browsable. Start it from the project root.

