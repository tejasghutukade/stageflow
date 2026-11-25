# Working against a running Host

Use this when asked to create or run work (a pipeline, task, run) while a Host is already up, especially a Docker console. Work that goes wrong is not lost: it lands in a project or data directory the console is not showing. Do the steps in order. Do not report success before step 4 passes.

## Contents

- Find the Host
- Pick the project
- Run through the Host
- Done means visible
- If something is missing

## Find the Host

`GET <base-url>/livez` needs no token and returns `{ "ok": true, "status": "live", "service": "stageflow", "version": "...", "home_id": "..." }`. Or run `node scripts/mcp-call.mjs --probe`. Note the URL and `home_id`. Every command must reach that Host's state: use MCP tools or the HTTP API first.

When the Host runs in a container, run the CLI inside it: `docker exec <container> sf ...`. Never run a bare `sf run` on the machine. Its `$STAGEFLOW_HOME` is another installation from the container's `/data`, so the run succeeds in a database the console never reads. `sf run` and `sf runs` report "Another Stageflow Host with a different data directory" when they detect this.

## Pick the project

The default target is `workspace` (`$STAGEFLOW_HOME/workspace`, `/data/workspace` in Docker). Write through the Host: MCP `write_pipeline`, `write_task`, `write_stage`, or the Workshop. `write_pipeline`, `write_stage`, `write_task` and `import_task` write into `workspace` when `project_root` is omitted, and their results carry `project_root`, `project_path` and, for pipelines, a `console_url`. `save_function` and `save_agent` still write to the Host's own project, so read `project_root` from their results.

Files in your current directory (a repo, a temp folder) are not in `workspace`. Create a separate folder or project only when the user asks. Then register it with the Host (`POST /api/projects`, or `STAGEFLOW_ENSURE_PROJECT_ROOTS`) and tell the user, by name, that it is a separate project. Remote MCP cannot register arbitrary paths (`ensure_project_not_allowed`).

## Run through the Host

Use MCP `start_run`, the console, or `sf run` inside the Host's home. Pass `project_root` explicitly whenever it is not `workspace`. Confirm before starting (see the Confirm first table in `SKILL.md`).

## Done means visible

Before you report success, confirm through the Host:

- `GET /api/pipelines` and `GET /api/tasks` list the pipeline and task under the expected `project_root`.
- `GET /api/runs/<id>` (or MCP `get_run`) shows the run, and each stage lists its published artifacts in `published_artifacts`.
- Give the user console links (`#/pipelines/<id>`, `#/runs/<runId>`, `#/artifacts`) and name the project. If it is not `workspace`, say so: some console views show only the active project.

## If something is missing

Do not edit `project_root` or workspace settings to make it appear. Work out which cause applies and tell the user:

- the files are in a different project from the one the console shows;
- the CLI and the console use two Stageflow homes (compare `home_id`);
- a project id (`workspace`) was compared with a path (`/data/workspace`).
