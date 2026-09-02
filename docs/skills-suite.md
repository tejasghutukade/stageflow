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
| [`stageflow`](../skills/stageflow/SKILL.md) | Router — the one name to remember. Names each job and when to reach it. |
| `stageflow-setup` | Install Stageflow, a catalog, and provider login |
| `stageflow-session-capture` | Turn a past session or this chat into a pipeline |
| `stageflow-author` | Author a pipeline from a loop the human can explain |
| `stageflow-run` | Start, watch, or answer a run. HITL uses the host native question UI when the gate maps; otherwise chat. Submit is always MCP `answer_gate`. |
| `stageflow-delegate` | Notice a repeating pattern and turn it into a reusable job |

Jobs share one MCP-vs-CLI rule: [`skills/stageflow/references/control-surface.md`](../skills/stageflow/references/control-surface.md). They do not each invent a second probe. When a host is up, prefer MCP; otherwise use the CLI. Tool and command names live in [MCP](mcp.md) and [CLI reference](cli-reference.md).

This suite is for **operator harnesses** (Cursor, Claude Code, Codex, Pi CLI, OpenCode). It is a different channel from Pi stage `skill:` binding. `sf skills list` and `sf skills install` provision those bindings under `.pi/skills/` — see [YAML catalog — skill binding](yaml-catalog.md#skill-binding) and [`sf skills`](cli-reference.md#sf-skills).

### Native question UI (`stageflow-run`)

The run job presents a waiting gate on the host picker when one is already in the tool list (`AskQuestion`, `AskUserQuestion`, `ask_user`). Representable gates go on the picker. Open-ended `free_text` and hosts without a picker stay in chat. A representable `multi_question` is one picker call, not sequential cards. Submit is still MCP `answer_gate`. See [`skills/stageflow-run/references/native-question-ui.md`](../skills/stageflow-run/references/native-question-ui.md).

## Install

From a consumer project (project-scoped — do not pass `-g`):

```bash
npx skills add tejasghutukade/stageflow
```

The CLI discovers the top-level `skills/` tree and copies each skill into the selected harness directories. Prefer a project install so Cloud Agents and teammates see the suite; user-level skill dirs do not travel to remote workers.

After the suite is on disk, ask the agent to set up Stageflow. That job (`stageflow-setup`) installs the CLI if needed.

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

The script is idempotent: a second run replaces the same six directories under each target. It always writes all three physical targets below. There is no per-harness opt-out.

## Harness install targets

Five harnesses collapse to three physical copy targets used by `install-suite.sh`:

| Harness | Physical copy target |
|---------|----------------------|
| Cursor | `.cursor/skills/<name>/` |
| Claude Code | `.claude/skills/<name>/` |
| Codex | `.agents/skills/<name>/` |
| Pi | `.agents/skills/<name>/` |
| OpenCode | `.agents/skills/<name>/` |

`npx skills add` writes each selected agent's native path instead (Cursor, Codex, and OpenCode use `.agents/skills/`; Claude Code uses `.claude/skills/`; Pi uses `.pi/skills/`). Cursor loads both `.agents/skills/` and `.cursor/skills/`.

## Non-goals

This suite does **not**:

- Publish to a skill marketplace
- Auto-start a standing MCP host. Setup (`stageflow-setup`) does not start `sf ui` or `sf mcp`. The run job may start a disposable `sf mcp --mcp-stateless` bridge to answer parked CLI HITL — that is not a standing host. See [`stageflow-run` Bridge](../skills/stageflow-run/SKILL.md#bridge), [MCP](mcp.md), and [Quick start](quickstart.md).
- Add new MCP HITL tools
- Replace `sf skills` / `.pi/skills/` for pipeline stage skill binding
