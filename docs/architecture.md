---
layout: default
title: Architecture
---

# Architecture

Stageflow is a local-first runtime for configurable multi-stage agent workflows. It separates **workflow orchestration** from **agent execution**: Stageflow owns the pipeline graph, scheduling, persisted state, handoff contracts, retries, human gates, and operator interfaces; agent execution runs behind `AgentPort`, with two selectable backends today — Pi (`@earendil-works/pi-coding-agent`, the default) and Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, opt-in per pipeline via an `agent:` field). Pipelines that don't opt in behave exactly as before; the two are additive, not a migration.

## System boundaries

![Stageflow architecture: pipeline definitions and operator interfaces drive the orchestration runtime, which coordinates agent execution and persisted state](img/stageflow-architecture.svg)

| Component | Responsibility | Primary code |
|---|---|---|
| Config loader | Load and validate manifests, tasks, stages, and resolved pipeline DAGs | `src/config/` |
| Run manager | Start/resume coordination, run capacity, checkout leases, retries, startup reconciliation | `src/runtime/runManager.ts` |
| DAG scheduler | Readiness, bounded parallelism, routing, fan-out/join, clone instances, failure propagation | `src/runtime/pipelineScheduler.ts` |
| Stage runtime | Build attempt context, open the agent, validate handoff and optional after-phase `verify`, record activity, coordinate gates | `src/runtime/stageRunner.ts`, `src/runtime/verifiedStageExecution.ts`, `src/runtime/stageAttemptBootstrap.ts` |
| Agent boundary | Stable stage input/result and live wait-or-complete session contract | `src/agent/port.ts` |
| Backend selection | Resolves which adapter a stage runs on (stage > pipeline > global > Pi). **Model** (LLM id) resolves separately with the same tier order but no `"pi"` fallback — see [YAML catalog — Model defaults](yaml-catalog.md#model-defaults-and-precedence) | `src/agent/resolveAgentPort.ts`, `src/agent/agentBackend.ts`, `src/config/resolveModel.ts` |
| Pi adapter | Translate Stageflow stage execution into Pi coding-agent sessions and tools | `src/agent/piAdapter.ts` |
| Claude adapter | Translate Stageflow stage execution into Claude Agent SDK sessions and tools | `src/agent/claudeAdapter.ts`, `claudeTools.ts`, `claudeActivity.ts`, `claudeSession.ts` |
| Persistence | Store run metadata, DAG snapshots, attempts, events, envelopes, artifacts, and projections | `src/runstore/` |
| Operator surfaces | Drive and inspect the same runtime through CLI, browser console, or MCP | `src/cli/`, `src/server/`, `src/mcp/`, `ui/` |

## Execution flow

1. **Load and validate.** Stageflow resolves the selected pipeline and task, validates stage references and graph wiring, and resolves the checkout root.
2. **Create the durable run record.** The runtime persists the task input, pipeline path, resolved DAG snapshot, checkout metadata, and a per-run workspace before scheduling work.
3. **Schedule ready stages.** The DAG scheduler derives readiness from predecessor states and completed envelopes. Independent nodes can run concurrently up to configured per-run and process limits.
4. **Open an isolated stage attempt.** In the default process mode, a stage worker opens a fresh agent session with the task, stage instructions, predecessor envelope data, and scoped workspace paths.
5. **Record activity.** Logs and lifecycle events are appended to the run store while the stage works. Artifacts are written inside the run workspace instead of being embedded into transcripts.
6. **Validate the handoff.** A successful stage emits a `StageEnvelope`. Stageflow validates its status, summary, artifacts, optional payload schema, and routing fields before downstream stages consume it.
7. **Run after-phase `verify` when configured.** Stageflow runs the declared `verify` checks after handoff validation, persists per-check evidence and the attempt's verification disposition, and accepts the candidate only when every required check passes.
8. **Route or wait.** The accepted envelope may select conditional successors or create clone instances. If the agent calls `ask_operator`, the stage parks as `waiting_for_input` until an answer is delivered through the console, MCP, or another supported operator path.
9. **Continue, recover, or finish.** The scheduler advances newly ready nodes, skips unreachable branches, applies `on_verify_fail` (automatic repair or a manual operator decision), and derives the final run outcome from persisted stage state.

## Handoff contract

Agent stages do not pass their full conversation histories to successors. They cross the boundary through a structured envelope:

```ts
type StageEnvelope = {
  status: "success" | "failure";
  summary: string;
  artifacts: string[];
  payload?: Record<string, unknown>;
  fork_choice?: string[];
  clone_forks?: CloneForkItem[];
  stage_id?: string;
  notes?: string;
};
```

The envelope is the control-plane handoff; artifacts are the data-plane handoff. A join stage can receive multiple predecessor envelopes without scraping or replaying their transcripts.

## Persistence and recovery

SQLite is the active `RunStore` adapter. State lives under `<git-root>/.stageflow/`, with per-run and per-attempt workspaces under `.stageflow/runs/`.

Stageflow persists:

- run metadata and a snapshot of the resolved DAG;
- stage attempts and lifecycle events;
- after-phase `verify` evidence and each attempt's verification disposition;
- terminal envelopes and artifact paths;
- pending operator prompts and session context needed to resume a parked stage;
- projections used by the console and MCP resources.

Persisted state lets the runtime reconstruct scheduler state for HITL resume and targeted retries. On process startup, Stageflow reconciles runs whose workers disappeared rather than silently treating them as active. This is local durable state, not a claim of distributed exactly-once execution.

## Human-in-the-loop lifecycle

`AgentPort.openStage()` returns a live `StageHandle`. The runtime pulls either a completion or a `waiting_for_input` event. A waiting attempt is parked without converting the prompt into an unstructured failure. When the operator answers, Stageflow reconstructs the run context, delivers the opaque answer to the adapter, and continues the remaining DAG.

How an adapter actually survives that park is adapter-internal and deliberately allowed to differ: Pi reopens its own on-disk session and splices the answer directly into the pending tool call, then resumes mid-thought. The Claude adapter never lets a tool call go dangling in the first place — `ask_operator` returns an immediate placeholder and the turn ends cleanly (via an `interrupt()` backstop), so parking has nothing to repair; answering resumes the same session as a new turn with the real prior conversation reloaded, not mid-thought. Both satisfy the same `StageHandle` contract from the runtime's point of view.

This same lifecycle supports interactive console use and headless automation: CI exits with code `2` when a run requires input, while MCP clients can discover waiting gates and answer them programmatically.

## Design decisions

### Fresh session per stage

Each stage starts with an intentional context boundary. This prevents an ever-growing shared transcript from becoming hidden workflow state and makes inputs reviewable. The tradeoff is that pipeline authors must decide what belongs in the envelope, payload, or artifacts.

### Explicit envelopes over transcript scraping

Downstream behavior depends on validated fields instead of prose conventions inside another agent's chat history. This enables schema validation, fork routing, joins, CI extraction, and retry reasoning. The tradeoff is a stricter completion protocol for stage authors.

### Pipeline-owned YAML

Workflow topology and stage configuration live with the consuming project, where they can be reviewed and versioned. Stageflow validates structure but does not hard-code domain-specific stage types. YAML favors reproducibility over fully dynamic, agent-invented orchestration.

### Orchestration behind ports

`AgentPort` keeps scheduling and persistence code independent of any one adapter's session mechanics — proven out by a second production implementation (Claude Agent SDK) alongside Pi, chosen via `resolveAgentPort()` and never affecting a stage that doesn't opt in. Model resolution (`resolveModel`) picks the LLM id string on a separate path from that backend choice. `RunStore` similarly keeps runtime call sites behind a persistence contract, even though SQLite is currently the only live adapter. These boundaries are extension seams, not promises that additional backends already exist — `AgentPort` already redeemed that promise once.

### Two backends, one contract

Pi and the Claude adapter satisfy `StageHandle.next()`/`deliverAnswer()`/`close()` identically, but are free to — and do — implement HITL wait/park/resume with completely different internal mechanisms (mid-thought session splicing vs. clean-stop-and-resume). Making one adapter's internals resemble the other's is not a goal; contract-level parity is. `tests/agent.port.contract.test.ts` and `tests/agent.claudeAdapter.test.ts` cover this from the port's side and the Claude adapter's side respectively — Pi's own mechanics are covered by its dedicated test files (`tests/agent.piAdapter.*.test.ts`) rather than a shared black-box harness, since Pi has no scriptable test seam equivalent to `FakeAgent`'s or the Claude adapter's mocked-SDK tests.

### Local-first operator control

The CLI, local console, and MCP server operate on the same run model. This keeps local and CI behavior aligned and makes stage state inspectable without introducing a hosted control plane. Stageflow is not currently a multi-tenant distributed orchestrator.

## Runtime invariants

- A stage becomes ready only when its required predecessors reach compatible terminal states.
- A successor consumes validated envelopes, not arbitrary predecessor transcripts.
- After-phase `verify` accepts a successful handoff only after every declared check passes (`on_verify_fail` is the fail policy; runtime IR still names this path `completion` / `recovery`).
- Run and stage lifecycle state is persisted before it is projected to operator surfaces.
- Waiting is a first-class state and is distinct from failure.
- Retries create new attempts and recompute affected downstream execution rather than rewriting prior history.
- The CLI, console, and MCP host drive the same runtime contracts.

## Related documentation

- [YAML catalog](yaml-catalog.md) — pipeline, stage, task, fork, and clone configuration
- [Envelopes](envelopes.md) — handoff schema, payload validation, and artifact rules
- [Verified Stage Execution](verified-stage-execution.md) — `verify` / `on_verify_fail`, evidence, and repair policy
- [Human-in-the-loop](hitl.md) — gate kinds, waiting behavior, and resume paths
- [CI / headless](ci.md) — JSON output, exit codes, and GitHub Actions
- [MCP](mcp.md) — tools and run resources
- [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp) — stage agents consuming project MCP servers
- [Operator console](operator-console.md) — runtime inspection and gate handling
