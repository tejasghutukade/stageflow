---
layout: default
title: Operator Console
---

# Operator console

The operator console is a local web UI started by `sf ui`. Default URL: **`http://127.0.0.1:3847`**.

It is the primary surface for triaging runs, answering HITL gates and agent approvals, building pipelines and agents, connecting providers and channels, and inspecting stage transcripts and envelopes. The same process also serves MCP at `/mcp`.

The run store is **global**, not project-scoped. It lives under the durable root (`$STAGEFLOW_HOME`, default `~/.stageflow/`) and is shared by every project on the machine, whichever directory you start `sf ui` from. Catalog browse (pipelines, tasks, skills, extensions) still resolves to the **project git root**: starting `sf ui` from a subdirectory uses `<git-root>/stageflow.yaml` and its declared catalog roots. See [Data directory](data-directory.md). `sf ui` is one of two ways to start the shared background service (`sf mcp` is the other, headless); `sf run` / `sf run-stage` / mutating `sf runs` commands auto-start the same service if neither is already running.

## Starting the console

```bash
sf ui
sf ui --port 9000
```

On start, Stageflow prints the console URL and MCP endpoint, then opens your default browser. The process runs until you stop it (Ctrl+C). In Docker the console is the container's published port; see [Docker](docker.md).

## One page per area

| Area | Page |
|------|------|
| Overview: needs-you, live runs, health, run trends | [Overview](console-overview.md) |
| Inbox: gates and agent approvals waiting on you | [Inbox](console-inbox.md) |
| Pipeline runs, run detail, Start a run | [Runs](console-runs.md) |
| Pipelines, editor, Tasks, Catalog, Triggers, Workshop | [Pipelines, tasks and catalog](console-pipelines-catalog.md) |
| Agents, Agent sessions, run inspector | [Agents in the console](console-agents.md) |
| Connections: channels, email accounts, tool servers | [Connections](console-connections.md) |
| Memories: a cover and cards a pipeline or an agent can keep | [YAML catalog — Memories](yaml-catalog.md#memories) |
| Settings: Providers, Concurrency, MCP, Project MCP, Notifications | [Settings](console-settings.md) |

## The shell

**Every page** shares one header bar (56px): title and count on the left, search and actions on the right. Detail pages put a back link (breadcrumb) before the title.

**App rail** (left; `ui/src/redesign/shell/navConfig.ts`). A search box (**⌘K**) and a **Start a run** button sit at the top; **Settings** and the provider status line sit in the footer.

| Group | Rail item | Route | Purpose |
|-------|-----------|-------|---------|
| (pinned) | **Overview** | `#/overview` | Control center: what needs you, what is running, health and run trends |
| (pinned) | **Inbox** | `#/inbox` | Triage home. The badge counts pipeline gates and agent approvals that wait on you |
| Activity | **Pipeline runs** | `#/runs` | All pipeline runs; the badge counts runs in flight |
| Activity | **Agent sessions** | `#/agent-sessions` | Every agent's sessions in one list; the badge counts sessions in flight |
| Build | **Pipelines** | `#/pipelines` | Browse pipeline files; open one in the editor |
| Build | **Agents** | `#/agents` | Agent directory, create, edit, detail |
| Build | **Tasks** | `#/tasks` | Task files |
| Build | **Catalog** | `#/catalog?tab=stages` | Stages, skills and extensions |
| Connect | **Triggers** | `#/triggers` | Catalog triggers |
| Connect | **Connections** | `#/connections` | Channels, email accounts, tool servers |
| Connect | **Memories** | `#/memories` | List and create memories. Edit the cover. List card keys, open a card, correct it, or delete it. A session adds cards. The pipeline editor and the agent editor attach memory ids from this list |
| (footer) | **Settings** | `#/settings` | General, Providers, Concurrency, MCP server, Project MCP, Notifications |

Below the groups, **Pinned pipelines** lists pipelines you pinned. The Workshop has no rail item of its own: reach it from a pipeline row (**Open in Workshop**, `W`), from **New pipeline** (`N`) or from the command palette. The rail footer can also show active run count vs soft max, the same data as MCP `get_health`.

### Command palette

**⌘K** (Ctrl+K) opens the palette from any page; **Esc** closes it. Type to filter, **↑/↓** to move, **Enter** to run.

| Group | Entries |
|-------|---------|
| Actions | **Start a run**; **Answer next gate** (when a run waits on you); **Retry failed stage** (when a run failed) |
| Runs | Recent runs, with status |
| Pipelines | Every pipeline, by id |
| Navigation | Overview, Inbox, Pipeline runs, Agent sessions, Agents, Pipelines, Workshop, Tasks, Catalog, Triggers, Settings |

### Keyboard shortcuts

Single keys are ignored while you type in a field. A shortcut works only on the page named below; the most specific page wins.

| Where | Keys |
|-------|------|
| Anywhere | **⌘K** palette · **Esc** close dialog |
| Inbox | **J / K** move · **O** open the run or agent session · **R** retry a failed run's stage (Failed tab) · **G** go to Pipeline runs (empty Needs you) |
| Inbox, a gate or agent approval selected | **1** Approve / Accept · **3** Deny / Reject · **N** focus the note (gates) · **O** open |
| Pipeline runs | **J / K** move · **Enter** open · **R** retry · **A** answer the waiting gate |
| Run detail | **F** start fresh (rerun) · **R** retry the failed stage · **C** copy the run id |
| Run detail, a stage waiting on you | **1** Accept · **3** Reject · **N** focus the note |
| Pipelines | **J / K** move · **Enter** open the editor · **S** start a run · **W** open in Workshop · **N** new pipeline · **/** search · **Esc** clear search |
| Pipeline editor | **⌘S** save · **A** add a stage · **⌥⇧F** format YAML · **⌘.** apply a quick fix |
| Tasks | **J / K** move · **Enter** open the last run · **S** start a run · **N** new task · **E** edit |
| Triggers | **J / K** move · **N** new · **/** search · **F** fire · **E** enable or disable |
| Catalog | **/** search · **J / K** move · **N** new stage (Stages tab) · **E** open the stage in the editor · **I** install a skill (Skills tab) · **Enter** open, **C** copy name (Skills tab) |
| Workshop | **V** validate · **A** add a stage · **⌘S** save · **Enter** accept the latest pending change |
| Agents list | **↑ / ↓** move the cursor · **Enter** or **Space** open |
| Agent editor | **⌘S** save |

## Start a run

`#/new` (or **Start a run**, or **S** on a pipeline or task) opens the Start Run dialog; optional `?pipeline=` and `?task=` query params preselect. See [Runs](console-runs.md#start-a-run).

## Routes

Hash-based routing (`ui/src/routes.ts`). A hash that matches no route falls back to the Inbox.

| Path | View |
|------|------|
| `#/overview` | [Overview](console-overview.md) |
| `#/inbox`, `#/inbox?tab=failed`, `?tab=done_today` | [Inbox](console-inbox.md). `#/today` opens it |
| `#/runs` | Pipeline runs (All / Needs you / Running / Failed / Succeeded) |
| `#/runs/<runId>` | Run detail |
| `#/runs/<runId>/stages/<stageId>` | Run detail with that stage selected |
| `#/runs/<runId>/stages/<stageId>/envelope` | Envelope inspector for a stage |
| `#/runs/<runId>/artifacts?path=…` | Artifact viewer |
| `#/new` | Start a run |
| `#/pipelines` | Pipeline list |
| `#/pipelines/<id>` | Opens that pipeline in the editor |
| `#/stages/<path>` | Stage file editor |
| `#/tasks`, `#/tasks/<id>` | Task list, one task |
| `#/triggers`, `#/triggers/<id>` | Trigger list, one trigger |
| `#/catalog?tab=stages` or `?tab=skills` | Catalog. `#/skills` and `#/skills/<name>` open the Skills tab; `#/extensions` opens the Stages tab |
| `#/extensions/packages/<scope>/<source>`, `#/extensions/files/<path>` | Extension package and file viewers |
| `#/connections`, `#/connections/<id>` | [Connections](console-connections.md) |
| `#/memories`, `#/memories/<id>` | Memory list and one memory. Create from the list. The operator can edit the cover. The page shows the previous cover text when it exists. List keys, open a card, and correct it. The page shows the previous card copy when it exists. Delete removes the current card and the previous copy and cannot be undone. There is one previous copy, not a full history, and no restore action. A session adds cards; the console does not. Attach memory ids in the pipeline inspector or the agent editor |
| `#/agents` | Agent directory |
| `#/agents/new` | Create an agent |
| `#/agents/<id>` | Agent detail (Sessions, Configuration) |
| `#/agents/<id>/edit` | Edit with diff review and version history |
| `#/agents/<id>/sessions/<sessionId>` | One agent session |
| `#/agents/<id>/sessions/<sessionId>/runs/<runId>` | Run inspector |
| `#/agent-sessions` (alias `#/agents/sessions`) | Sessions across all agents |
| `#/settings` | [Settings](console-settings.md) |
| `#/workshop` | Workshop |
| `#/connect` | Provider connect flow |

Recent runs show stored **`pipeline_path`** and **`task_path`** locators when present on the run record.

## Workshop

The Workshop (`#/workshop`) is the interactive pipeline authoring surface. It is covered on [Pipelines, tasks and catalog](console-pipelines-catalog.md#workshop-workshop) and in [Workshop Author](workshop.md).

## MCP co-location

MCP Streamable HTTP is available at `<console-origin>/mcp` while `sf ui` runs (sessions by default). For MCP without the console, use `sf mcp` instead. Both bind the same well-known local port as the one shared global service, so don't run both at once. See [MCP](mcp.md).

## Screenshots

`docs/img/` holds brand assets (`stageflow-og.svg`, `stageflow-icon.svg`). There are no console screenshots yet.

## See also

- [Quick start](quickstart.md): first console session
- [HITL](hitl.md): answering gates from the Inbox or the run workspace
- [Agents](agents.md) and [Communication channels](channels.md)
- [`examples/generic-fan-in/`](../examples/generic-fan-in/): diamond join and envelope inspector
- [Providers](providers.md): Settings → Providers
- [MCP](mcp.md): automation alongside the UI
- [CLI reference](cli-reference.md): `sf ui --port`
- [Harness skills suite](skills-suite.md): operator harness jobs (not the Skills page)
