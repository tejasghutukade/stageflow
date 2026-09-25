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

## Repository binding

Task binding is **`repository` + `ref` XOR `checkout`** (code `task.binding_conflict` if both). Do not set both.

| Binding | Meaning |
|---|---|
| `repository` + `ref` | GitHub `owner/repo` plus branch/tag/SHA. Host creates a worktree at `$STAGEFLOW_HOME/worktrees/<runId>/`. On **succeeded**, that worktree may be reclaimed (`run_branch` kept; path may be gone → checkout tools return `checkout_reclaimed`). Repository-bound runs parallelize; they do not take the path `busy_checkout` lease. |
| `checkout` | Path-bound working tree. `busy_checkout` is this path lease only — conflicting path-bound starts fail and never queue. |

CLI parity with MCP inline: `sf run --repository owner/repo --ref <ref>` (or `--checkout <path>`), and the same fields on throwaway scratch YAML.

## Task input

### MCP

An existing `task_path` from `list_tasks`, or an inline `task` object built from the stated goal:

```json
{ "id": "<slug>", "goal": "<goal>", "context": "optional", "constraints": "optional", "checkout": "optional", "repository": "optional", "ref": "optional" }
```

Use either `repository`+`ref` or `checkout`, not both. `start_run` accepts that object. Do not write a scratch file on the MCP path. After start, inspect checkout state with `list_checkout_changes`, `get_run_diff`, or `read_checkout_file` when the human asks what changed in the bound tree (reclaimed succeeded worktrees → `checkout_reclaimed`).

### CLI

`sf run` accepts `--task <path>` plus optional `--repository` / `--ref` or `--checkout`. Reuse a catalog `*.task.yaml`, or write a throwaway file at the project root:

```
.scratch/stageflow-run/<id>.task.yaml
```

```yaml
id: <slug>
goal: <human goal>
```

Add `context`, `constraints`, `checkout`, or `repository` + `ref` only when the human gave them (same XOR as MCP). Pass that path as `--task`. Overrides: `--repository owner/repo --ref <ref>` or `--checkout <path>`.

## Optional run flags

`--checkout`, `--repository`, `--ref`, `--git-sha`, `--ci-pr-url`, `--ci-job-url` only when the human supplied them. Do not use `--operator-cwd` / `--operator-agent-dir` (no-ops); set `STAGEFLOW_OPERATOR_CWD` / `STAGEFLOW_OPERATOR_AGENT_DIR` before Host first start.
