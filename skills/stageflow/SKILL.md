---
name: stageflow
description: Entry point and router for the Stageflow (`sf`) skill suite. Stageflow is a runtime for configurable multi-stage agent workflows (pipelines of stages, human gates, project agents, evals) with a local operator console, a CLI, and an MCP endpoint. Use for installing or upgrading the CLI, `sf init`, the stageflow.yaml manifest, provider login and model choice, `sf doctor`, starting the Host (`sf ui`, `sf mcp`), connecting this harness to the MCP endpoint, Docker or hosted setup, concepts and vocabulary, troubleshooting, and any general or unclear Stageflow request. Routes pipelines to `stageflow-pipelines`, agent files (`approvals.ask_first`, the agent channel, memories) to `stageflow-agents`, runs, pipeline-stage connections and Inbox approval decisions to `stageflow-operate`, and evals to `stageflow-evals`.
compatibility: Needs Node 20+ and npm for the `sf` CLI, or Docker for the published image. Running stages needs credentials for at least one model provider.
---

# Stageflow

Stageflow runs configurable multi-stage agent workflows. A user writes pipeline YAML. Each stage runs in a fresh agent session and hands off through a typed envelope. Gates pause for a human. The same pipeline runs locally, in CI (`sf run --json`), and through MCP. Stages are domain-agnostic: release automation, research, content review, ops runbooks and software delivery are all ordinary pipelines.

This skill routes the request, then owns setup, the control-surface rule, vocabulary and troubleshooting.

## Route the request

Pick the row that matches the user's goal and read that skill next. If two rows fit, do the earlier step first (author, then run, then evaluate).

| The user wants to | Use |
|---|---|
| Write, change, validate or explain a pipeline, stage, task, trigger or the catalog; turn a chat into a pipeline | `stageflow-pipelines` |
| Create or change a project agent: instructions, tools, `approvals.ask_first`, the agent's own channel, memories (`list_memories`, `create_memory`), schedules, chat | `stageflow-agents` |
| Start, watch, answer, retry, cancel or inspect runs; connect Slack, email or another provider for a pipeline stage send; Inbox approval decisions; read artifacts; run in CI | `stageflow-operate` |
| Measure quality: eval files, datasets, graders, compare runs, sort failures | `stageflow-evals` |
| Install, log in to a provider, run `sf init`, start or connect to the Host, Docker, fix a setup problem, learn a term | this skill |
| Anything else about Stageflow, or the request is unclear | this skill: ask one question that names the options above |

Common crossings:

- "Run my pipeline" is `stageflow-operate`. "Why does it not validate" is `stageflow-pipelines`. "It will not start" is usually setup: read `references/troubleshooting.md`.
- A pipeline stage and a project agent are different things. A stage runs once inside a run. An agent holds conversations and is not part of a pipeline. See `references/concepts.md`.
- An agent's own channel, `approvals.ask_first`, and memories (`list_memories`, `create_memory`) are `stageflow-agents`. Pipeline-stage connections and Inbox approval decisions are `stageflow-operate`. Both are set up through MCP or the console, not YAML secrets.
- If a sibling skill is not installed, say so, and use `sf --help` for the command list and the `get_started` MCP tool's `next_steps`.

## Ground rules

1. Code beats docs. Before telling the user a flag, env var, route or file name, confirm it with `sf <command> --help` or by reading what the Host returns. This suite was verified against Stageflow 0.54.
2. Confirm before anything that costs money, is destructive, or is visible outside the machine: real model runs, evals, deletes, `docker run`, `docker compose up`, sending through a channel, exposing the Host on a network.
3. Never put a secret in YAML, a file you write, a log, a command line or chat. Providers and tokens go through `sf providers login`, `STAGEFLOW_PROVIDER_<ID>_API_KEY_FILE`, token files and environment variables. If a step needs a human to type a key, tell them so and stop there.
4. Prefer MCP when a Host is up and its tools are in your tool list. Otherwise use the CLI with `--json`. The full rule is in `references/control-surface.md`.
5. `sf validate` checks shape and wiring. It does not check provider credentials, model ids, the `CHANGE_ME` placeholder from `sf init`, or that a stage prompt is good. `sf doctor` checks the machine. A real run is the only proof.
6. These skills manage Stageflow, not Pi. `sf skills` installs Pi project skills into `.pi/skills`. It does not install these harness skills.

## Setup checklist

Run the steps in order. Each ends with a check you can observe. Skip a step only when its check already passes. Detail and failure handling are in `references/setup.md`.

- [ ] **1. Probe.** Run `node --version` (needs 20+), `sf --version`, and `node <this skill's folder>/scripts/detect-host.mjs`. The script prints `up <url>` or `down <url>`, with `bearer` appended when a control token is set in the environment. Done when you know which of CLI, Host and provider are missing.
- [ ] **2. Install or upgrade the CLI.** `npm i -g stageflow` installs `sf` and `stageflow`. Compare `sf --version` with `npm view stageflow version`; upgrade when behind. If the global install fails with a permissions error, do not use `sudo`: use `npx stageflow` in place of `sf` and tell the user. Done when `sf --version` prints the latest version.
- [ ] **3. Log in to a provider before `sf init`.** The sample pipeline's model comes from the providers already configured. Run `sf providers list`, then `sf providers status`. A human runs `sf providers login <id>` for a key prompt or OAuth. In CI or an agent shell use `--api-key-env <VAR>` with a key already in the environment. Done when `sf providers status` shows `configured` for the chosen provider. See `references/providers-and-models.md`.
- [ ] **4. Initialize the project.** In the project root (a git repo is best) run `sf init`. It creates `stageflow.yaml`, `pipelines/hello.pipeline.yaml` and `tasks/hello.task.yaml` and skips files that exist. If the hello model reads `CHANGE_ME/...`, replace it with a real `provider/model` id. Then run `sf validate --strict --json`. Done when the output has `"ok": true` and the exit code is 0.
- [ ] **5. Check the machine.** `sf doctor`. Done when no line is `[fail]`. Read the `[warn]` lines to the user; the `credentials` warning is a known false alarm for stored logins (see `references/troubleshooting.md`).
- [ ] **6. Start or find the Host.** Local use needs no step: the first command that needs a Host starts one on `127.0.0.1:3847`. To open the console, run `sf ui` in a separate terminal. For a headless Host, run `sf mcp`. Never run either in the foreground of your own shell. Done when `detect-host.mjs` prints `up`. See `references/host-and-mcp.md`.
- [ ] **7. Connect this harness to MCP (optional).** Do this when the user needs tools the CLI lacks (connections, memories, live run inspection, agent and eval authoring), or the Host is in a container or remote. Add the `/mcp` URL to the harness MCP config, with a bearer token if the Host has one. Done when a call to the `get_started` tool returns the Host version. Config snippets per harness are in `references/host-and-mcp.md`.
- [ ] **8. Report.** Tell the user what is ready (CLI version, provider, project root, Host URL, MCP connected or not) and what is blocked and what they must do. Offer the next skill from the router table. Do not start a real run unless they ask and confirm.

Docker and hosted users replace steps 2 and 6 with `references/docker-and-hosted.md`.

## References

Read only the file the task needs. Files over 100 lines start with a table of contents.

| File | Read it when |
|---|---|
| `references/setup.md` | Doing the checklist in detail: install, manifest, `sf init`, `sf doctor`, data directory, upgrading, backup |
| `references/providers-and-models.md` | Logging in to a provider, headless keys, choosing and setting a model, judge providers |
| `references/control-surface.md` | Deciding MCP or CLI, which commands autostart a Host, `--json` and exit codes |
| `references/host-and-mcp.md` | Starting the Host, ports, tokens, health endpoints, MCP client config for Cursor, Claude Code, Codex and OpenCode, project registration |
| `references/docker-and-hosted.md` | Running the published image, compose, container-only commands, the hosted library |
| `references/concepts.md` | Explaining a term or telling two similar things apart |
| `references/troubleshooting.md` | Anything failed: autostart errors, port clashes, validation codes, run failures, provider errors |

## Updating this suite

Skills are installed with `npx skills add tejasghutukade/stageflow`; run it again to update. The suite describes the CLI release it was verified against (see ground rule 1). When `sf --version` is older, some commands are missing: `sf browser` needs 0.29, `sf agents` 0.37, `sf eval` 0.41.
