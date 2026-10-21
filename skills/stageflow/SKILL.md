---
name: stageflow
description: >-
  Routes Stageflow work to one job: setup (install, catalog, provider, or
  optional Docker Compose local try), session-capture (reuse this chat or a past
  session), author (a loop the human can explain), run (start, watch, or answer
  a pipeline), or delegate (a repeating pattern). Use when the user mentions
  Stageflow, sf, a pipeline, HITL, an eval of a stage, or a repeating
  Stageflow workflow.
compatibility: Requires the Stageflow CLI (sf). An MCP host (sf ui or sf mcp) is optional.
---

# Stageflow

Read [references/control-surface.md](references/control-surface.md) before talking to a run (and [references/evals.md](references/evals.md) before talking about evals). Probe with [scripts/detect-host.mjs](scripts/detect-host.mjs). Do not restate that policy here.

Read the matching job `SKILL.md` and follow it. Do not invent job behavior in this router.

| Reach this job when | Read |
|---|---|
| Install is missing, there is no catalog, a provider is not logged in, or the operator wants Docker Compose local try | [../stageflow-setup/SKILL.md](../stageflow-setup/SKILL.md) |
| The request should reuse a past session or this chat | [../stageflow-session-capture/SKILL.md](../stageflow-session-capture/SKILL.md) |
| The request describes a loop the human can explain | [../stageflow-author/SKILL.md](../stageflow-author/SKILL.md) |
| The request needs to start, watch, or answer a run | [../stageflow-run/SKILL.md](../stageflow-run/SKILL.md) |
| The request repeats a known pattern, or could become one | [../stageflow-delegate/SKILL.md](../stageflow-delegate/SKILL.md) |

Evals are not a sixth job. When the request is to measure, test or compare a stage (is this stage any good, did my prompt change help, run the eval), read [references/evals.md](references/evals.md): `sf eval validate` is free, `sf eval run` calls models and costs money, so confirm before running. Writing the eval and dataset files belongs to `stageflow-author`; starting and reading an eval run follows the same MCP-vs-CLI rule as a pipeline run.

If none of those fit, name the five jobs in one line and ask which.
