---
layout: default
title: Documentation
permalink: /
---

# Stageflow documentation

Stageflow is an open-source runtime for **configurable multi-stage agent workflows**. You author **pipeline-owned YAML** — `*.pipeline.yaml`, separate `*.task.yaml` files, optional repo-root `stageflow.yaml` manifest — and Stageflow schedules fresh agent sessions with explicit envelopes and artifacts between stages. [Pi](https://github.com/badlogic/pi-mono) is the current agent execution backend.

Stages are **author-defined and domain-agnostic**. Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns; nothing in Stageflow hard-codes a domain.

## Getting started

| Doc | What you'll learn |
|-----|-------------------|
| [Quick start](quickstart.md) | Install, `sf init`, path-based run |
| [YAML catalog](yaml-catalog.md) | Author dialect `io` / `verify` / `on_verify_fail` and wiring `route` / `entry` / `type: loop` / [Clone Chain](yaml-catalog.md#clone-chain) ([upgrading older catalogs](yaml-catalog.md#upgrading-older-catalogs)) |
| [CLI reference](cli-reference.md) | `sf init`, `sf run`, `sf run-stage`, `sf validate`, `sf eval`, `sf envelope`, `sf ui`, `sf mcp`, `sf providers` |
| [Harness skills suite](skills-suite.md) | `npx skills add tejasghutukade/stageflow` — router + five job skills for Cursor, Claude Code, Codex, Pi, and OpenCode |

## Core concepts

| Doc | What you'll learn |
|-----|-------------------|
| [Architecture](architecture.md) | Runtime boundaries, execution flow, persistence, recovery, and design tradeoffs |
| [Hosted runtime](hosted.md) | Public library contract for embedding one inline pipeline run |
| [Envelopes](envelopes.md) | Stage handoff contract (`emit_stage_envelope`, artifacts) |
| [Verified Stage Execution](verified-stage-execution.md) | After-phase `verify`, evidence, and `on_verify_fail` repair / manual recovery |
| [Human-in-the-loop](hitl.md) | Gate kinds, operator replies, `--skip-gates`, exit code `2` |
| [Agents](agents.md) | Project-owned agents (`agents/*.agent.yaml`): overview and where the pieces live |
| [Agent definition](agent-definition.md) | Every field of an agent file, defaults and limits, reserved ids, revisions, validation issues |
| [Agent runtime](agent-runtime.md) | Turns, tool grants, ask-first approvals, guardrails, sub-agents, limits, restart behaviour |
| [Agent observability](agent-observability.md) | Spans, capture modes, redaction, OTLP export, groundedness evals |
| [Agent API](agent-api.md) | REST routes, CLI and MCP tools for agents, webhooks and the public chat API |
| [Set up your first agent](guides-agents-first-agent.md) | Create, test and enable an agent |
| Agent channel guides | [Email (AgentMail)](guides-agents-email.md), [iMessage](guides-agents-imessage.md), [Slack](guides-agents-slack.md), [Telegram](guides-agents-telegram.md), [schedules](guides-agents-schedule.md), [web chat](guides-agents-web-chat.md) |
| [MCP servers](mcp-servers.md) | Add MCP servers, secrets and OAuth from Settings or `.mcp.json`; use them from agents and stages |
| [Glossary](glossary.md) | Agent, agent session, pipeline run, connection, Project MCP and other terms |
| [Workshop Author](workshop.md) | Chat-draft a pipeline at `#/workshop`, save it into the catalog, and run it |
| [Evals](evals.md) | Check a stage or an agent against a dataset: eval files, datasets, graders (schema, field, reference, rubric, code, and for agents tool_calls, conversation_check, goal_reached), repeats and honest statistics, compare, cost limits, the engine, [Evals for agents](evals.md#evals-for-agents) (scenarios, tool and approval policy, eval sessions), privacy, what is not built |
| [Browser sessions](browser.md) | Stage `browser` field, saved logins (profiles), login check and human login pattern, queueing, teardown, headed vs headless, live view and watch-the-agent for Hosts with no screen, container browser host (development), Host config keys, what is not built |
| [Browser sessions internals](browser-internals.md) | For contributors: module map, lifecycle, file layout, env contract, invariants, seams, extension recipes, test and debug guide for browser sessions |
| [Providers](providers.md) | Pi model auth — `pi_home` vs `sf_owned` |
| [Email accounts](email-accounts.md) | IMAP accounts for email triggers |
| [Communication channels](channels.md) | connecting AgentMail, Slack, Telegram, iMessage and WhatsApp, linking a connection to a stage, `connections.yaml` and secret handling, run-start checks, the Connections page API, and troubleshooting |

## Operating Stageflow

| Doc | What you'll learn |
|-----|-------------------|
| [Data directory](data-directory.md) | Durable root layout, keep vs disposable, image user, version support |
| [Docker and self-hosting](docker.md) | Local Compose try (`.env.example`, control token, providers), pull/run, never mount docker.sock, browser image recipes (`Dockerfile.browser`, `Dockerfile.browser-sandbox`) and container browser host config, backup/restore, provenance, hardened egress (docs-only) |
| [Operator console](operator-console.md) | Navigation, command palette, keyboard shortcuts and routes |
| [Console: Overview](console-overview.md) | Control center: what needs you, what is running, system health, run trends |
| [Console: Inbox](console-inbox.md) | Gates and agent approvals waiting on you, desktop notifications |
| [Console: Pipeline runs](console-runs.md) | Run list, Start a run, run detail (Timeline, Graph, List; Transcript, Events, Envelope, Artifacts) |
| [Console: Pipelines, tasks and catalog](console-pipelines-catalog.md) | Pipeline editor, Tasks, Catalog, Triggers, Workshop |
| [Console: Evals](console-evals.md) | Evals list, New eval wizard (stage or agent), Datasets and scenarios, Run dialog and live progress, results, case drawer and conversation transcript, Compare |
| [Console: Agents](console-agents.md) | Directory, create and edit, sessions, run inspector |
| [Console: Connections](console-connections.md) | Channels, email accounts, tool servers |
| [Console: Settings](console-settings.md) | Providers, Concurrency, MCP server, Project MCP, Notifications |
| [Environment variables](environment-variables.md) | Every `STAGEFLOW_*` variable the Host reads |
| [Migrating stage environments](migration-stage-environment.md) | Move stages to declared secrets and the curated stage environment |
| [Triggers readiness](triggers-readiness.md) | Checklist: which trigger kinds and console options the Host runs today vs manual-only |
| [MCP](mcp.md) | Streamable HTTP tools when `sf ui` or `sf mcp` is running, including standalone `run_stage` and the eval tools |
| [A2A](a2a.md) | Publish pipelines for other agents to invoke over JSON-RPC, plus the wildcard-access `run_stage` operation |
| [CI / headless](ci.md) | `--json`, exit codes, `sf eval run` in CI, GitHub Actions, PR diagram dogfood |

## Featured example

**[Archify on PR](../examples/archify-on-pr/)** — pull-request diagram automation dogfooding Stageflow in GitHub Actions: unused-path skip, pipeline skill binding, `sf envelope get --format handoff`, and deterministic Archify deliver outside the agent. See [CI: PR diagrams (Archify)](ci.md#pr-diagrams-archify) and [examples/archify-on-pr/README.md](../examples/archify-on-pr/README.md).

For join skip vs fail (two named parents into one child, inspect keyed envelopes) and a runnable tour of deterministic route `if` (operators, composition, skip, join fire and miss), see [YAML catalog — Generic fan-in](yaml-catalog.md#generic-fan-in) and [`examples/route-if-tour/`](../examples/route-if-tour/). For a short spine of every `verify` check type (artifact, command, checklist, payload_schema, gate, checkout_changes), see [`examples/verify-tour/`](../examples/verify-tour/). For emit soft-reject, automatic repair, manual recover, and ordinary Retry, see [`examples/retry-tour/`](../examples/retry-tour/).

For source-owned feedback loops (`continue` / `send_back`), see [`examples/feedback-loop/`](../examples/feedback-loop/) and [YAML catalog — Feedback loops](yaml-catalog.md#feedback-loops). For MCP-host HITL (`answer_gate`) plus exhausted-loop `decide_feedback_loop`, see [`examples/mcp-hitl-tour/`](../examples/mcp-hitl-tour/). For stage agents consuming project MCP servers, see [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp), [`examples/stage-mcp/`](../examples/stage-mcp/), [`examples/playwright-mcp/`](../examples/playwright-mcp/), and [`examples/context7-mcp/`](../examples/context7-mcp/).

## Canonical YAML examples

Test fixtures under [`tests/fixtures/`](../tests/fixtures/) are the source of truth for valid catalog shapes:

- [`tests/fixtures/pipelines/`](../tests/fixtures/pipelines/) — source of truth for current `route` / `entry` shapes (fan-out, diamond fan-in, loops), Clone Chain shapes (`clone-chain-*.pipeline.yaml`), plus HITL and validation edge cases (`*.pipeline.yaml`)
- [`tests/fixtures/stages/`](../tests/fixtures/stages/) — gate kinds, `io` / `verify` shapes (referenced via `uses:`)
- [`tests/fixtures/tasks/`](../tests/fixtures/tasks/) — task file shapes (`*.task.yaml`)

Runnable walkthroughs live in [`examples/`](../examples/) (see [`examples/README.md`](../examples/README.md)). Clone Chain shapes live under the fixtures above; there is no `examples/` Clone Chain walkthrough.

## See also

- [README](../README.md) — product landing page and installation
- [GitHub Issues](https://github.com/tejasghutukade/stageflow/issues) — support and bug reports
