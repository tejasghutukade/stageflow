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
| **Today** | `#/today` | Triage home — waiting runs, capacity, quick actions |
| **Runs** | `#/runs` | All runs list |
| **Pipelines** | `#/pipelines` | Browse manifest-declared pipeline files |
| **Tasks** | `#/tasks` | Browse manifest-declared task files |
| **Skills** | `#/skills` | Pi skills available to stages |
| **Extensions** | `#/extensions` | Pi extensions (user and project scope) |
| **Settings** | `#/settings` | App settings including providers |

**Start a run** — primary button in the rail → `#/new` (optional `?pipeline=` and `?task=` query params with filesystem paths).

Brand click returns to Today.

Waiting runs show a count badge on Today when gates need replies.

## Key routes

Hash-based routing (`ui/src/routes.ts`):

| Path | View |
|------|------|
| `#/today` | Triage dashboard |
| `#/runs` | Runs index |
| `#/runs/<runId>` | Run detail — stage timeline, live stream |
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
| `#/settings` | Settings (providers, theme, etc.) |
| `#/connect` | Provider connect flow |

Recent runs show stored **`pipeline_path`** and **`task_path`** locators when present on the run record.

## Run detail

The run detail stream view shows:

- Per-stage status and attempts
- Agent activity / transcript
- **HITL reply** surfaces when a stage calls `ask_operator` — free text, confirm, multi-question, artifact-backed review
- Links to envelope and artifact views

Use envelope view to read `summary`, `payload`, and artifact paths without parsing logs.

### Clone tracks {#clone-tracks}

Fan-out clones appear as distinct track nodes labeled `definition · N` (for example `work · 1`). Selecting a node uses the instance id (`work~1`) as the key. A run-once successor stays the catalog id (`work`).

When the selected stage has an envelope, the first Files row is **Handoff envelope** — it opens the envelope inspector; meta is the instance id. Artifact rows keep that same instance id. Walkthrough: [`examples/clonable-fanout/`](../examples/clonable-fanout/) scenario A, step 6.

Run detail keeps refreshing a run whose overall status is failed while another clone is still `waiting_for_input` or running after retry.

Answering HITL on a selected clone: [HITL](hitl.md#console-reply).

## Capacity indicator

The rail footer can show active run count vs soft max (`get_health` semantics) — same data as MCP `get_health`.

## Settings

**Providers** — connect, disconnect, and inspect Pi model providers (`pi_home` vs `sf_owned`). See [Providers](providers.md).

Other settings (theme, etc.) follow console UX conventions in `ui/AGENTS.md`.

## MCP co-location

MCP Streamable HTTP is available at `<console-origin>/mcp` while `sf ui` runs. See [MCP](mcp.md).

## Screenshots

Product screenshots for README and docs live under `docs/img/` when captured (e.g. operator console runs view).

## See also

- [Quick start](quickstart.md) — first console session
- [HITL](hitl.md) — answering gates in run detail
- [`examples/clonable-fanout/`](../examples/clonable-fanout/) — clone track walkthrough
- [Providers](providers.md) — Settings → Providers
- [MCP](mcp.md) — automation alongside the UI
- [CLI reference](cli-reference.md) — `sf ui --port`
