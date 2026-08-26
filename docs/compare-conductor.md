---
layout: default
title: Compare Conductor
---

# Stageflow vs Conductor

[Conductor](https://github.com/microsoft/conductor) and Stageflow both address **multi-step agent workflows**. They differ in orchestration model, runtime, and the unit of composition.

This page is positioning, not a feature scorecard. Choose based on whether you want **YAML-defined Pi stages with envelopes** or **multi-agent graphs with Jinja routing**.

## At a glance

| | **Stageflow** | **Conductor** |
|---|---------------|---------------|
| **Model** | Configurable **stages** on Pi; YAML catalog (any domain) | Multi-**agent** workflow graph |
| **Orchestration** | Pipeline DAG + stage worker | Jinja routing, no LLM in router |
| **Unit of work** | Task → Pipeline → Stage attempts | Workflow → Agents |
| **Handoff** | Typed **envelope** + artifacts | Agent output → context |
| **Human gates** | Operator console + MCP | Dashboard + TUI fleet |
| **Runtime** | Node.js, Pi coding agent | Python, Copilot/Claude SDKs |
| **Best for** | Personal/team **multi-stage Pi workflows** you define (releases, research, SDLC, …) | Enterprise multi-agent workflows |

## Stageflow's model

- **Stages are author-defined** in YAML — no built-in domain. SDLC, release automation, research, and custom ops flows are all the same mechanism.
- Each stage runs in a **fresh Pi session** with a fixed tool surface (`write_stage_artifact`, `ask_operator`, `emit_stage_envelope`).
- **Envelopes** are the contract between stages: `status`, `summary`, `artifacts`, optional typed `payload`.
- **HITL** pauses a run for operator input; CI gets exit code `2` or `--skip-gates` for unattended jobs.
- **Operator console** (`sf ui`) triages runs, providers, and gate replies on one machine — no separate fleet manager TUI.

## Conductor's model

- **Agents** are first-class nodes in a workflow graph; routing is template-driven (Jinja), not LLM-based.
- Handoffs are primarily **context accumulation** across agents rather than a single emit-once envelope per stage.
- Enterprise-oriented tooling: dashboard, fleet manager TUI, plugin/skill marketplace patterns.
- Python ecosystem with Copilot/Claude SDK integrations.

## When to use Stageflow

- You already run or want to run **Pi** as your coding agent
- You want **repeatable YAML pipelines** with reviewable handoffs (envelopes + artifacts)
- You need the same flow **locally, in CI (`sf run --json`), and at the console**
- Your workflows are **stage-bound** — clear boundaries, one agent session per stage, explicit success/failure emit

## When to use Conductor

- You need **many specialized agents** in one graph with deterministic template routing
- You're standardized on Conductor's Python stack and Microsoft agent SDKs
- You want fleet-scale orchestration patterns (dashboard + TUI) out of the box

## Message

If you want deterministic YAML routing across many agents, look at [Conductor](https://github.com/microsoft/conductor).

If you want stage-bound Pi runs with reviewable envelopes and an operator console for **workflows you author**, use Stageflow.

## Overlap and differences (intentional)

| Topic | Stageflow | Conductor |
|-------|-----------|-----------|
| Config format | `pipelines/`, `stages/`, `tasks/` | Workflow YAML + agent definitions |
| Parallelism | Pipeline DAG (`needs`) | Graph parallelism |
| CI story | `sf validate`, `sf run --json`, exit 0/1/2 | Conductor CLI / Actions patterns |
| MCP | Streamable HTTP when `sf ui` runs | Varies by deployment |
| Fleet TUI | Not planned — single-project console | Fleet Manager |

Stageflow dogfoods its own release pipeline (`examples/github-release/`) — proof that configurable stages can run real automation, not just demos.

## See also

- [README](../README.md) — product overview and comparison table
- [YAML catalog](yaml-catalog.md) — how stages are defined
- [Envelopes](envelopes.md) — handoff contract
- [Quick start](quickstart.md) — try Stageflow in minutes
