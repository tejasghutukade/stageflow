---
name: stageflow
description: >-
  Routes Stageflow work to one job: setup (install, catalog, or provider),
  session-capture (reuse this chat or a past session), author (a loop the human
  can explain), run (start, watch, or answer a pipeline), or delegate (a
  repeating pattern). Use when the user mentions Stageflow, sf, a pipeline,
  HITL, or a repeating Stageflow workflow.
compatibility: Requires the Stageflow CLI (sf). An MCP host (sf ui or sf mcp) is optional.
---

# Stageflow

Read [references/control-surface.md](references/control-surface.md) before talking to a run. Probe with [scripts/detect-host.mjs](scripts/detect-host.mjs). Do not restate that policy here.

Read the matching job `SKILL.md` and follow it. Do not invent job behavior in this router.

| Reach this job when | Read |
|---|---|
| Install is missing, there is no catalog, or a provider is not logged in | [../stageflow-setup/SKILL.md](../stageflow-setup/SKILL.md) |
| The request should reuse a past session or this chat | [../stageflow-session-capture/SKILL.md](../stageflow-session-capture/SKILL.md) |
| The request describes a loop the human can explain | [../stageflow-author/SKILL.md](../stageflow-author/SKILL.md) |
| The request needs to start, watch, or answer a run | [../stageflow-run/SKILL.md](../stageflow-run/SKILL.md) |
| The request repeats a known pattern, or could become one | [../stageflow-delegate/SKILL.md](../stageflow-delegate/SKILL.md) |

If none of those fit, name the five jobs in one line and ask which.
