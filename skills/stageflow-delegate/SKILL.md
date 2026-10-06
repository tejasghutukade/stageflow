---
name: stageflow-delegate
description: Looks up a catalog pipeline for a repeating request, then reuses it or codifies it and runs. Use when this skill is opened for a repeating-pattern request.
disable-model-invocation: true
---

# Stageflow delegate

Look up the catalog once, then branch. A match runs; no match authors, then runs.

Talking jobs cite [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md). This job names `stageflow-run` for execution and does not choose MCP vs CLI.

1. Look up the requested pattern. Follow [`references/pattern-detection.md`](references/pattern-detection.md) until you have a match, a disambiguation, or no match.
2. Branch on that result. Follow [`references/authoring-or-run.md`](references/authoring-or-run.md). Name `stageflow-run` and stop.

Act only when this skill is the one opened. Leave the harness's builtin subagents in place; never suggest disabling, replacing, or bypassing them.

Worked pair: [`references/example-walkthrough.md`](references/example-walkthrough.md).
