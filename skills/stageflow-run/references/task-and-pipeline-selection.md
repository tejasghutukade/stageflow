# Task and pipeline selection

Resolve one pipeline filesystem path and one task before `start_run` or `sf run`. Ask a disambiguating question on more than one match. Do not guess.

## Named

If the human named a pipeline or task, match that string against catalog `id` and `path`. One match → use it. Several → print id + path and ask which. Zero → say so and offer the catalog list.

## Unnamed

Print a short pick list (id + path). Ask which.

## MCP catalog

`list_pipelines` and `list_tasks` (native tools, or [`mcp-call.md`](mcp-call.md)). Listing objects carry `path` and `id`.

## CLI catalog

There is no CLI list command. Read `stageflow.yaml` at the project root (git top-level when `git rev-parse --show-toplevel` succeeds, otherwise the current directory).

Walk each `catalog.pipelines` / `catalog.tasks` root. Match `catalog.patterns.pipeline` (default `*.pipeline.yaml`) and `catalog.patterns.task` (default `*.task.yaml`). Skip paths whose repo-relative prefix is in `catalog.exclude`.

## Task input

### MCP

An existing `task_path` from `list_tasks`, or an inline `task` object built from the stated goal:

```json
{ "id": "<slug>", "goal": "<goal>", "context": "optional", "constraints": "optional", "checkout": "optional" }
```

`start_run` accepts that object. Do not write a scratch file on the MCP path.

### CLI

`sf run` accepts `--task <path>` only. Reuse a catalog `*.task.yaml`, or write a throwaway file at the project root:

```
.scratch/stageflow-run/<id>.task.yaml
```

```yaml
id: <slug>
goal: <human goal>
```

Add `context`, `constraints`, or `checkout` only when the human gave them. Pass that path as `--task`.

## Optional run flags

`--checkout`, `--git-sha`, `--ci-pr-url`, `--ci-job-url` only when the human supplied them.
