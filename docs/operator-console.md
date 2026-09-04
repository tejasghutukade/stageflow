---
layout: default
title: Operator Console
---

# Operator console

The operator console is a local web UI started by `sf ui`. Default URL: **`http://127.0.0.1:3847`**.

It is the primary surface for triaging runs, connecting providers, answering HITL gates, and inspecting stage transcripts and envelopes. The same process also serves MCP at `/mcp`.

The run store and catalog browse resolve to the **project git root** — starting `sf ui` from a subdirectory still uses `<git-root>/.stageflow/` and the repo's `stageflow.yaml` manifest.

## Starting the console

```bash
sf ui
sf ui --port 9000
```

On start, Stageflow prints the console URL and MCP endpoint, then opens your default browser. The process runs until you stop it (Ctrl+C).

## Navigation (app rail)

Left rail items (`ui/src/components/AppRail.tsx`):

| Rail id | Route | Purpose |
|---------|-------|---------|
| **Today** | `#/today` | Triage home — waiting, in flight, broken, finished. Eligible waiting cards can Accept from Today. |
| **Runs** | `#/runs` | All runs, filterable All / Waiting / Running / Failed / Finished |
| **Pipelines** | `#/pipelines` | Browse manifest-declared pipeline files; scaffold a new pipeline or stage into the catalog |
| **Tasks** | `#/tasks` | Browse manifest-declared task files |
| **Skills** | `#/skills` | Browse Pi skills for stages — not the [harness skills suite](skills-suite.md) |
| **Extensions** | `#/extensions` | Browse Pi extensions for stages |
| **Settings** | `#/settings` | Appearance, Providers, MCP how-to, Concurrency (session slots), waiting notifications |

**Start a run** — primary button in the rail → `#/new` (optional `?pipeline=` and `?task=` query params with filesystem paths).

Brand click returns to Today.

Waiting runs show a count badge on Today when gates need replies.

Runs and Pipelines list rows stack identity above a full-width mini track so catalog paths stay readable.

## Key routes

Hash-based routing (`ui/src/routes.ts`):

| Path | View |
|------|------|
| `#/today` | Triage dashboard (waiting / in flight / broken / finished) |
| `#/runs` | Runs index (All / Waiting / Running / Failed / Finished) |
| `#/runs/<runId>` | Run detail — spatial stage map; select a node for the workspace |
| `#/runs/<runId>/stages/<stageId>` | Deep link — select that stage on the map and open its workspace |
| `#/runs/<runId>/stages/<stageId>/envelope` | Envelope inspector for a stage |
| `#/runs/<runId>/artifacts?path=…` | Artifact viewer |
| `#/new` | Start run form |
| `#/pipelines` | Pipeline catalog (manifest paths) |
| `#/pipelines/<id>` | Single pipeline detail |
| `#/tasks` | Task catalog |
| `#/tasks/<id>` | Single task detail |
| `#/skills`, `#/skills/<name>` | Skills browser |
| `#/extensions` | Extensions index |
| `#/extensions/packages/<scope>/<source>` | Extension package detail |
| `#/extensions/files/<path>` | Extension file viewer |
| `#/settings` | Settings (Appearance, Providers, MCP, Concurrency, waiting notifications) |
| `#/connect` | Provider connect flow |

Recent runs show stored **`pipeline_path`** and **`task_path`** locators when present on the run record.

## Run detail

The live pane is a zoomable spatial stage map (`SpatialRunMap`). Selecting a stage opens a gated, resizable workspace for logs, files, envelopes, and HITL. Hide the workspace to return to the map; drag the splitter to resize. **Fit run** recenters the graph.

A created run shows status **not started**. The primary action is **Start run** until history exists; after that it is **Start fresh** (rerun).

`#/runs/<runId>/stages/<stageId>` selects that stage on the map and opens the workspace.

Failed stage nodes offer **Retry**. When a failed completion check has
`recovery.mode: manual`, the selected stage instead shows its verification history
and offers **Retry with guidance** or **Stop recovery**. Running stage nodes offer
**Abandon**. A stage waiting on HITL uses the workspace reply surface (`answer_gate`),
not retry.

Use the envelope view to read `summary`, `payload`, and artifact paths without parsing logs.

### Clone tracks {#clone-tracks}

Fan-out clones appear as distinct spatial nodes labeled `definition · N` (for example `work · 1`). Selecting a node uses the instance id (`work~1`) as the key. A run-once successor stays the catalog id (`work`).

When the selected stage has an envelope, the first Files row is **Handoff envelope** — it opens the envelope inspector; meta is the instance id. Artifact rows keep that same instance id. Walkthrough: [`examples/clonable-fanout/`](../examples/clonable-fanout/) scenario A, step 6.

Run detail keeps refreshing a run whose overall status is failed while another clone is still `waiting_for_input` or running after retry.

Answering HITL on a selected clone: [HITL](hitl.md#console-reply).

## Capacity indicator

The rail footer can show active run count vs soft max (`get_health` semantics) — same data as MCP `get_health`.

## Settings

**Appearance** — theme for this machine.

**Providers** — connect, disconnect, and inspect Pi model providers (`pi_home` vs `sf_owned`). See [Providers](providers.md).

**MCP** — how to point a client at this console process (`/mcp` while `sf ui` is running).

**Concurrency** — session slots (how many stage sessions may be alive at once). A stage waiting on you still holds its slot.

**Held stages** — waiting notifications (system notification or off). A held stage is invisible if this window is closed.

## MCP co-location

MCP Streamable HTTP is available at `<console-origin>/mcp` while `sf ui` runs (sessions by default). For MCP without the console, use `sf mcp` instead — do not run both against the same project store. See [MCP](mcp.md).

## Screenshots

`docs/img/` holds brand assets (`stageflow-og.svg`, `stageflow-icon.svg`).

## See also

- [Quick start](quickstart.md) — first console session
- [HITL](hitl.md) — answering gates from Today or the run workspace
- [`examples/clonable-fanout/`](../examples/clonable-fanout/) — clone walkthrough
- [Providers](providers.md) — Settings → Providers
- [MCP](mcp.md) — automation alongside the UI
- [CLI reference](cli-reference.md) — `sf ui --port`
- [Harness skills suite](skills-suite.md) — operator harness jobs (not the Skills rail)
