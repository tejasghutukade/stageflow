---
layout: default
title: Skills Suite
---

# Harness skills suite

The Stageflow **harness skills suite** is one Agent Skills tree that coding agents load from a consumer project. It covers configurable-stage work — release automation, research flows, ops runbooks, SDLC, and anything else you author in pipeline YAML. It is not an SDLC-only pack.

Install the suite into a consumer project with `npx skills add tejasghutukade/stageflow`. The same tree ships in the `stageflow` npm package for the checkout/npm copy path.

## What ships

| Directory | Role |
|-----------|------|
| [`stageflow`](../skills/stageflow/SKILL.md) | Router, and setup: install the CLI, `sf init`, provider login, the Host, Docker, and troubleshooting. |
| [`stageflow-pipelines`](../skills/stageflow-pipelines/SKILL.md) | Design, write, and repair pipelines, stages, and tasks. Includes turning a chat or a past session into a pipeline, and turning a repeating request into a reusable one. |
| [`stageflow-agents`](../skills/stageflow-agents/SKILL.md) | Design, write, and test project agents: tools, approvals, MCP servers, memories, schedules, channels, and protected chat. |
| [`stageflow-operate`](../skills/stageflow-operate/SKILL.md) | Start, watch, and answer runs. HITL uses the host native question UI when the gate maps; otherwise chat. Also connections, saved browser logins, triggers, A2A callers, and approvals. |
| [`stageflow-evals`](../skills/stageflow-evals/SKILL.md) | Write, validate, run, compare, and sort evals of a stage or an agent. |

When a Host is up and its tools are in the agent's tool list, prefer MCP. Otherwise use the CLI with `--json`. Commands that talk to the Host start a headless service on `127.0.0.1:3847` unless `STAGEFLOW_NO_AUTOSTART` is set or `STAGEFLOW_SERVICE_PORT` points somewhere else. Tool and command names live in [MCP](mcp.md) and [CLI reference](cli-reference.md). The shared rule is [`skills/stageflow/references/control-surface.md`](../skills/stageflow/references/control-surface.md).

This suite is for **operator harnesses** (Cursor, Claude Code, Codex, Pi CLI, OpenCode). It is a different channel from Pi stage `skill:` binding. `sf skills list` and `sf skills install` provision those bindings under `.pi/skills/` — see [YAML catalog — skill binding](yaml-catalog.md#skill-binding) and [`sf skills`](cli-reference.md#sf-skills).

### Evals

`stageflow-evals` owns the eval lifecycle for a stage or an agent: write the eval and dataset, `sf eval validate` (free), then `sf eval run --json` (calls models and costs money, so the agent confirms first). Agent evals grade the conversation, cost more (agent, simulator, and judge), and use read-only tools unless the file and the run both allow real tools. See [Evals](evals.md).

### Native question UI (`stageflow-operate`)

The operate skill presents a waiting gate on the host picker when one is already in the tool list (`AskQuestion`, `AskUserQuestion`, `ask_user`). Representable gates go on the picker. Open-ended `free_text` and hosts without a picker stay in chat. A representable `multi_question` is one picker call, not sequential cards. Submit with MCP `answer_gate` when the host is up, or `sf runs answer --json` when it is down. See [`skills/stageflow-operate/references/native-question-ui.md`](../skills/stageflow-operate/references/native-question-ui.md).

## Install

From a consumer project (project-scoped — do not pass `-g`):

```bash
npx skills add tejasghutukade/stageflow
```

The CLI discovers the top-level `skills/` tree and copies each skill into the selected harness directories. Prefer a project install so Cloud Agents and teammates see the suite; user-level skill dirs do not travel to remote workers.

After the suite is on disk, ask the agent to set up Stageflow. The `stageflow` skill installs the CLI if needed.

### npm / checkout fallback

If the CLI is already installed, copy the same tree with [`skills/install-suite.sh`](../skills/install-suite.sh):

```bash
bash "$(npm root -g)/stageflow/skills/install-suite.sh"
```

From a Stageflow checkout (before publish, or against another project):

```bash
bash /path/to/stageflow/skills/install-suite.sh --dest-cwd /path/to/your/project
```

| Flag | Meaning |
|------|---------|
| `--source-dir PATH` | Canonical tree (default: the script's own directory) |
| `--dest-cwd PATH` | Project root to install into (default: current directory) |

The script is idempotent: a second run replaces the same five directories under each target. It always writes all three physical targets below. There is no per-harness opt-out. It also removes a leftover `stageflow-setup`, `stageflow-author`, `stageflow-session-capture`, `stageflow-delegate`, or `stageflow-run` directory when that directory's `SKILL.md` has a `name:` equal to the directory name. A directory with a different `name:` or no `SKILL.md` is left in place. If you installed the old suite and do not re-run the script, delete those five directories yourself.

## Harness install targets

Five harnesses collapse to three physical copy targets used by `install-suite.sh`:

| Harness | Physical copy target |
|---------|----------------------|
| Cursor | `.cursor/skills/<name>/` |
| Claude Code | `.claude/skills/<name>/` |
| Codex | `.agents/skills/<name>/` |
| Pi | `.agents/skills/<name>/` |
| OpenCode | `.agents/skills/<name>/` |

Those paths are **install output** copied from the published `skills/` tree — not a second source of truth. After you change the suite, re-run `skills/install-suite.sh` (or `npx skills add`) so local copies match. Author catalog dialect for new pipelines is `io` / `verify` / `on_verify_fail` (see [YAML catalog](yaml-catalog.md)).

`npx skills add` writes each selected agent's native path instead (Cursor, Codex, and OpenCode use `.agents/skills/`; Claude Code uses `.claude/skills/`; Pi uses `.pi/skills/`). Cursor loads both `.agents/skills/` and `.cursor/skills/`.

## Non-goals

This suite does **not**:

- Publish to a skill marketplace
- Open the operator console by itself. Commands that need a Host start a headless service on `127.0.0.1:3847` (override with `STAGEFLOW_SERVICE_PORT`; set `STAGEFLOW_NO_AUTOSTART` to refuse). The console is `sf ui`. For a standing local Host, use Docker Compose local try — see [Docker — Local try (Compose)](docker.md#local-try-compose). See [CLI reference — `sf runs`](cli-reference.md#sf-runs), [MCP](mcp.md), and [Quick start](quickstart.md).
- Add new MCP HITL tools
- Replace `sf skills` / `.pi/skills/` for pipeline stage skill binding
