---
layout: default
title: Working against a running Host
---

# Working against a running Host

For an outside agent (Claude Code, Codex, Cursor) or a Stageflow agent asked to create a pipeline and run it while a Host is already up. The work is never lost when it goes wrong. It lands in a project, or in a data directory, that the console is not showing. Follow the checklist in order and do not report success until step 4 passes.

## Checklist

1. **Find the Host first.** `GET <base-url>/livez` needs no token and returns `{ "ok": true, "status": "live", "service": "stageflow", "version": "…", "home_id": "…" }`. Note the URL and `home_id`. Every command must reach that Host's state: use the Stageflow MCP tools or the HTTP API first. When the Host runs in a container, run the CLI inside it with `docker exec <container> sf …` ([CLI via docker exec](docker.md#cli-via-docker-exec)). Do not run a bare `sf run` on the machine: its `$STAGEFLOW_HOME` is a different installation from the container's `/data`, and the run succeeds in a database the console never reads.
2. **Pick the target project on purpose.** The default is `workspace` (`$STAGEFLOW_HOME/workspace`, `/data/workspace` in Docker). Write through the Host: MCP `write_pipeline`, `write_task` and `write_stage`, or the Workshop. `write_pipeline`, `write_stage`, `write_task` and `import_task` write into `workspace` when you omit `project_root`, and their results carry `project_root`, `project_path` and, for pipelines, a `console_url`. `get_started` lists the other catalog roots. `save_function` and `save_agent` still write to the Host's own project, so read `project_root` from their results. Create a separate folder or project only when the user asks. Then register it with the Host (`POST /api/projects`, or `STAGEFLOW_ENSURE_PROJECT_ROOTS`; see [Catalog roots](mcp.md#catalog-roots-and-project_root)) and tell the user, by name, that it is a separate project. Files in your current directory are not in `workspace`.
3. **Run through the Host.** Use MCP `start_run`, the console, or `sf run` inside the Host's home. Pass `project_root` explicitly whenever it is not `workspace`.
4. **Done means visible.** Before you report success, confirm through the Host:
   - `GET /api/pipelines` and `GET /api/tasks` list the pipeline and task under the expected `project_root`.
   - `GET /api/runs/<id>` (or MCP `get_run`) shows the run, and each stage lists its published artifacts in `published_artifacts`.
   - Then give the user the `console_url` from the tool result, or console links (`#/pipelines/<id>`, `#/runs/<runId>`, `#/artifacts`), and say which project the work is in. Pipeline, artifact and trigger links can carry a project; run, task, agent and function links cannot, so name the project in your message. If it is not `workspace`, say so, because some console views show only the active project.
5. **Do not "fix" visibility by editing `project_root` or workspace settings.** If something is missing, work out which cause applies and tell the user:
   - the files are in a different project from the one the console is showing;
   - the CLI and the console use two different Stageflow homes (compare `home_id`);
   - a project id (`workspace`) was compared with a path (`/data/workspace`).

See also [Docker and self-hosting](docker.md), [MCP](mcp.md), [Operator console](operator-console.md).
