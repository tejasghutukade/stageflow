---
layout: default
title: Operator Console
---

# Operator console

The operator console is a local web UI started by `sf ui`. Default URL: **`http://127.0.0.1:3847`**.

It is the primary surface for triaging runs, connecting providers, answering HITL gates, and inspecting stage transcripts and envelopes. The same process also serves MCP at `/mcp`.

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
| **Pipelines** | `#/pipelines` | Browse pipeline definitions |
| **Tasks** | `#/tasks` | Browse task files |
| **Skills** | `#/skills` | Pi skills available to stages |
| **Extensions** | `#/extensions` | Pi extensions (user and project scope) |
| **Settings** | `#/settings` | App settings including providers |

**Start a run** — primary button in the rail → `#/new` (optional `?pipeline=` and `?task=` query params).

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
| `#/pipelines` | Pipeline catalog |
| `#/pipelines/<id>` | Single pipeline detail |
| `#/tasks` | Task catalog |
| `#/tasks/<id>` | Single task detail |
| `#/skills`, `#/skills/<name>` | Skills browser |
| `#/extensions` | Extensions index |
| `#/extensions/packages/<scope>/<source>` | Extension package detail |
| `#/extensions/files/<path>` | Extension file viewer |
| `#/settings` | Settings (providers, theme, etc.) |
| `#/connect` | Provider connect flow |

## Run detail

The run detail stream view shows:

- Per-stage status and attempts
- Agent activity / transcript
- **HITL reply** surfaces when a stage calls `ask_operator` — free text, confirm, multi-question, artifact-backed review
- Links to envelope and artifact views

Use envelope view to read `summary`, `payload`, and artifact paths without parsing logs.

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
- [Providers](providers.md) — Settings → Providers
- [MCP](mcp.md) — automation alongside the UI
- [CLI reference](cli-reference.md) — `sf ui --port`
