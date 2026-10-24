# AGENTS.md

Guidance for contributors and AI coding agents working on the Stageflow repository.

## What Stageflow is

Stageflow is a runtime for **configurable multi-stage agent workflows**, with a local operator console. [Pi](https://github.com/badlogic/pi-mono) is the current agent execution backend.

- Users author **pipeline-owned YAML** (`*.pipeline.yaml`, `*.task.yaml`, optional `stageflow.yaml` manifest)
- Each stage runs in a fresh Pi agent session
- Stages hand off via typed envelopes and artifacts
- HITL gates pause for operator input; the same pipeline runs locally, in CI (`sf run --json`), via MCP when `sf ui` or `sf mcp` is running, and host-down via `sf runs`
- The orchestration layer is separated from agent execution by `StagePort`

**Stages are domain-agnostic.** Release automation, research flows, content review, SDLC, and ops runbooks are all valid patterns. Stageflow validates shape and wiring; it does not ship domain-specific stage types.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/` | CLI, runtime, config loader, MCP, HTTP server |
| `ui/` | Operator console (Vite + React workspace) |
| `tests/` | Vitest suite; **`tests/fixtures/`** is canonical YAML |
| `examples/` | Runnable walkthroughs with READMEs |
| `docs/` | Public reference (YAML, CLI, CI, MCP, etc.) |
| `skills/` | Harness Agent Skills suite — router, shared MCP-vs-CLI reference, job skills |
| `examples/evals/` | Sample evals: a stage sample (pipeline, dataset, eval, task) and an agent sample (`support-sample.*`: agent, dataset, eval), installed by `POST /api/evals/sample` (`kind` stage or agent) |

### `src/` map (high level)

| Directory | Responsibility |
|-----------|----------------|
| `cli/` | `sf run`, `sf runs`, `sf validate`, `sf eval`, `sf ui`, `sf providers` |
| `config/` | YAML load/validate, pipeline DAG resolution; eval and dataset loaders, write path and sample install |
| `runtime/` | Pipeline runner, stage worker, HITL, scheduling |
| `runstore/` | SQLite run state under `$STAGEFLOW_HOME` (default `~/.stageflow/`) |
| `agent/` | Pi coding agent adapter |
| `agents/` | Project-owned conversational agents: service (definitions, revisions, sessions), chat turns, tool gate, approvals. Eval sessions (`source: "eval"`, `evalSession.ts`, `evalGate.ts`, `toolRisk.ts`) are agent sessions run for evals |
| `mcp/` | MCP server and tools |
| `server/` | HTTP routes for the operator console API |
| `browser/` | Browser sessions: profile store, lock, host, login check, teardown (see `docs/browser.md`) |
| `tools/` | Pi tools (`ask_operator`, `emit_stage_envelope`, …) |
| `evals/` | Evals: stats, scoring, compare, plan and snapshot, run manager, graders (envelope and conversation), case runners (`runner/`: stage in `stageCaseRunner.ts`, agent in `agentCaseRunner.ts` with user drivers and the simulator), `EvalEngine` interface with `FakeEngine` and the promptfoo engine (`engine/promptfoo/`), read models for the API (see Evals below) |
| `envelope/` | Envelope schema and validation |

Entry point: `src/cli.ts`. Library exports: `src/index.ts`.

## Commands

From repo root after `npm i`:

```bash
npm run build          # compile CLI to dist/
npm test               # vitest (src + integration)
npm run typecheck      # tsc --noEmit
npm run ui:build       # build console + copy assets into dist/ui
npm run ui:test        # vitest in ui workspace
sf ui                  # operator console (requires build + ui:build)
```

Dev entrypoint without a global install:

```bash
npm run dev -- ui
npm run dev -- run \
  --task tests/fixtures/tasks/sample.task.yaml \
  --pipeline tests/fixtures/pipelines/single.pipeline.yaml
```

Optional: `npm run ui:dev` for Vite hot reload against a running `sf ui` backend.

Repo-root [`stageflow.yaml`](stageflow.yaml) lists example catalog roots and excludes `tests/fixtures` from operator-console browse (fixtures remain loadable by explicit path in tests).

## YAML authoring

When changing pipeline/stage/task schema, validation, or doc examples:

- Read **[docs/yaml-catalog.md](docs/yaml-catalog.md)** — authoritative schema reference, including `io` / `verify` / `on_verify_fail`, [Clone Chain](docs/yaml-catalog.md#clone-chain), and stage `mcp` / `.mcp.json` ([Stage MCP](docs/yaml-catalog.md#stage-mcp)). Do not author `clonable` / `clone_forks` (rejected).
- **YAML vs IR.** Author new catalog contracts as `io` / `verify` / `on_verify_fail` and map them in `compileTargetContract` (`src/config/yamlDialect.ts`). Runtime types, DAG snapshots, emit, and VSE keep `payload_schema` / `pre_emit_checks` / `completion` / `recovery`. Dual-read of old YAML keys: [`src/config/legacyYaml.ts`](src/config/legacyYaml.ts)
- Treat **`tests/fixtures/`** as canonical YAML; keep `examples/` in sync when behavior changes
- Runnable walkthroughs: **[examples/README.md](examples/README.md)**

Related docs: [evals.md](docs/evals.md), [envelopes.md](docs/envelopes.md), [hitl.md](docs/hitl.md), [cli-reference.md](docs/cli-reference.md), [ci.md](docs/ci.md), [mcp.md](docs/mcp.md).

## Making changes

1. Match existing patterns in the area you touch — minimal, focused diffs
2. Run `npm test`, `npm run ui:test`, and `npm run typecheck` before finishing
3. No comments unless logic is non-obvious
4. Do not commit secrets or `.env` files

### CLI / runtime work

- JSON output and exit codes are part of the public contract — see `docs/ci.md` and `tests/cli.*.test.ts`
- Stage worker protocol: `src/runtime/stageWorkerProtocol.ts`
- Provider auth: `src/agent/providerAuth.ts`, `docs/providers.md`

### Browser sessions

Stage `browser:` field, saved logins, shared browser per run. Code: `src/browser/`, `src/cli/browserCommand.ts`, `src/config/stageBrowser.ts`, `builtin-skills/browser/SKILL.md`, plus hooks in `src/runtime/` (scheduler, run manager, stage launcher). Read [docs/browser-internals.md](docs/browser-internals.md) before changing it; user docs are [docs/browser.md](docs/browser.md).

Rules every change must keep:

- The stage browser env is byte-identical for every command, attempt, and resume worker. Compute once, persist, reuse.
- YAML never carries a path or a scope. The Host chooses both.
- The owner scope is fixed to `local` today. Hosted multi-tenant work is tracked in `TODO(multi-tenant)` comments (`grep -rn "TODO(multi-tenant)" src`) and the table in [docs/browser-internals.md](docs/browser-internals.md#multi-tenant-todo). Keep new code taking a scope as input, never a literal.
- Tests use an injected `BrowserRunner` (no real `agent-browser`) and a per-test `socketRoot`. `tests/globalSetup.socketLeakGuard.ts` fails the run on leaked socket dirs.

Real Chrome smoke test (opt-in, needs `agent-browser` on `PATH`): `STAGEFLOW_BROWSER_SMOKE=1 npx vitest run tests/browser.realChrome.smoke.test.ts`

### Context and compaction

Pi stage sessions, project agents and the operator agent compact their own context. Code: `src/compaction/`, `src/tools/workingState.ts`, `src/agent/piSettings.ts`, `src/agent/toolOutputBudget*.ts`, `src/agent/compactionEvents.ts`; the harness is `scripts/compaction-eval/`. User docs: **[docs/context-and-compaction.md](docs/context-and-compaction.md)**. Read it and `docs/plans/compaction-strategy.md` (local-only) before changing any of it.

Rules every change must keep:

- **Compaction is always on and not configurable.** Build Pi settings only through `createPiSettingsManager()`; never write `compaction: { enabled: false }`.
- **Compaction is ordinary work.** Its model call is charged to the stage's `StageUsage` and the agent's cost like any other call; add no special budget handling.
- **The assignment lives in the system prompt** (`composeStagePiSystemPrompt`), which compaction never rewrites. Do not move the envelope contract back into the first user message.
- **`read` and `bash` share a per-turn token cap** (`decideTurnCap`); the first result of a turn always returns.
- **Pinned facts, directives, cleared-result placeholders and working state are deterministic and secret-scrubbed** (`redactString` plus `scrubSecrets`). A secret never enters `stageflowPinned` details, the summary sections or `working_state`.
- **Only re-fetchable, successful read-only tool results may be cleared** (`classifyForClearing` fails closed). Errors, operator answers, emits and side-effecting calls are never cleared.
- **The hook falls back to Pi's default compaction on any failure**, never to nothing; an abort is rethrown.
- **`working_state` is internal**: it bypasses the agent tool gate and approvals, is exempt from the tool-output budget, and its guidance (`WORKING_STATE_GUIDANCE`) is in every stage and agent system prompt.
- **Bump `COMPACTION_PROMPT_VERSION`** (`src/compaction/types.ts`) when the focus prompt or the summary section layout changes, and re-run `scripts/compaction-eval/` before and after.
- **OpenRouter routing is a Host concern.** `createOpenRouterRoutingExtension` only adds `require_parameters` to tool requests and never overrides routing set in `models.json`; do not put a provider in YAML.
- **A leaked tool call ends the stage with a clear provider error** (`LEAKED_TOOL_CALL_ERROR`), not `missing emit_stage_envelope`.
- **No test calls a real model.** The harness's real-model runs are manual and capped (`--max-cost-usd`).

### Tests

- Tests live in `tests/*.test.ts`
- Fixtures: `tests/fixtures/pipelines/`, `stages/`, `tasks/`
- Prefer extending fixtures over inline YAML when behavior is catalog-driven

## UI work

Operator console code lives in **`ui/`**. Read **[ui/AGENTS.md](ui/AGENTS.md)** for UI-specific rules (Astryx workflow, chrome exception, UX docs, component map). Do not duplicate that file here.

### Connections (communication channels and tools)

Send-only stage channels are built (`src/channels/`, `src/tools/sendMessage.ts`, `src/server/channelRoutes.ts`, `ui/src/redesign/connections/`, the editor's `StageChannelsSection`). User docs: **[docs/channels.md](docs/channels.md)**. Before changing them or adding a provider, read that page. Local-only working notes (gitignored, not in the repo) may exist at `docs/specs/connections-spec.md`, `connections-provider-reference.md` and `connections-design-handoff.md`; if you have them, the provider reference holds verified third-party facts.

Rules every change must keep:

- A secret is never a YAML value, never in a response, log, error, run state or the stage worker. Providers get secrets only through `ResolvedConnection` (non-enumerable). Errors carry codes, never response bodies or request URLs.
- Recipients are pinned in YAML. The agent never chooses one.
- A send that may have reached the provider is `CHANNEL_SEND_OUTCOME_UNKNOWN` and is never resent. Only definite failures (refused connection, DNS/TLS, 4xx) are retryable or resendable under a new key.
- A stage uses one channel (`MAX_CHANNELS_PER_STAGE`). Keep it enforced at parse, merge, validation and send; tests that need several raise it with `setStageChannelLimitForTests`.
- Connections are host-level (`$STAGEFLOW_HOME/connections.yaml`, project file wins, `STAGEFLOW_CONNECTIONS_FILE` overrides). The test setup pins an empty `STAGEFLOW_HOME` so host files never leak in.
- A provider is one file: its adapter, its `meta` (form fields, recipient shape, examples; the console renders from `GET /api/connections/meta`) and its tests. Every `ChannelErrorCode` is explained once in `src/channels/errorInfo.ts` (a `Record`, so a missing entry is a compile error). After changing either, run `npx tsx scripts/generate-channel-meta-fixture.ts` so the console fixture matches; `tests/channels.metaFixture.test.ts` fails if it does not.
- Connection edits (create, replace key, enable, remove) go through `ConnectionEdits.apply`, which changes secrets and file together and undoes both on failure. Do not write the secret store or `connections.yaml` anywhere else.
- Provider tests use the local HTTP fixture or a fake SDK importer, never the network. Real-account smoke tests are opt-in env-gated files.

### Evals

Evals check a stage or an agent over a dataset of cases, grade every output (for an agent, the whole conversation and its tool calls), repeat each case and compare runs. Code: `src/evals/`, loaders and write path in `src/config/` (`loadEval.ts`, `validateEval.ts`, `loadDataset.ts`, `writeEval.ts`, `writeDataset.ts`, `installEvalSample.ts`), `src/cli/evalCommand.ts`, `src/server/evalRoutes.ts`, `src/mcp/evalTools.ts`, console `ui/src/redesign/evals/`. User docs: **[docs/evals.md](docs/evals.md)** and [docs/console-evals.md](docs/console-evals.md). Read `docs/specs/evals.md` (the epic with every decision) and the `docs/specs/evals-*.md` contracts before changing evals; they may exist only in a maintainer's local checkout, so ask for them if they are missing. Where merged code differs from a spec, the code and the user docs win.

Rules every change must keep:

- **Numbers are computed in three files only:** `src/evals/stats.ts`, `scoring.ts` and `compare.ts`. The UI formats what the API returns and never computes a statistic. A change to a formula needs a hand-computed test.
- **Nothing outside `src/evals/engine/promptfoo/` imports or names promptfoo types.** The engine sits behind the `EvalEngine` interface; `FakeEngine` is what tests use. Engine status, install, pinned-version and run-token modules in that folder are wiring that the CLI, doctor and server may import; shared helpers (`src/evals/judgeProviders.ts`, `providerKeys.ts`) live outside it.
- **The engine never touches the store.** It reports results through callbacks; `EvalRunManager` persists them, owns the cost limit, cancel and one-run-at-a-time.
- **Graders read a normalized subject** (`src/evals/graders/subject.ts`), never the stage envelope or an agent session directly. There are two kinds of subject, `envelope` (stage) and `conversation` (agent, built by `runner/conversationSubject.ts`); a grader that cannot apply to a kind is `EVAL_GRADER_NOT_APPLICABLE` at validation.
- **The target is a tagged reference** (`kind`). Result tables are target-neutral: no stage-only columns; stage details live in JSON columns and the config snapshot.
- **A config snapshot is written once and never edited.** The fingerprint covers what changes results and excludes the cost cap and concurrency.
- **Bump `RUBRIC_PROMPT_VERSION`** (`src/evals/constants.ts`) whenever the stage judge prompt text changes; it is part of the snapshot and the fingerprint. Bump `CONVERSATION_RUBRIC_PROMPT_VERSION` for the conversation judge prompt and `SIMULATOR_PROMPT_VERSION` for the simulator prompt, not the stage constant, so stage fingerprints stay comparable.
- **Agent evals: eval sessions are hidden.** A session an eval opens is an agent session with `source: "eval"`. Every operator-facing list, count, Inbox, approval and retention path in `src/agents/` excludes them; pass `includeEval` only in eval code, and never expose it to a request parameter. A new agent query must keep the exclusion.
- **Agent evals: the eval tool gate fails closed and cannot weaken the real gate.** `src/agents/evalGate.ts` runs first for eval sessions only; a session with no registered gate is denied every tool; a non-eval session's gate path stays byte-identical. Tool classification lives in `toolRisk.ts`; anything not provably read-only (MCP tools included) is stubbed unless the author lists it.
- **Agent evals: `read_only` is the default tool policy and `real` needs explicit consent twice** (`conversation.allow_real_tools` in the file and the per-run flag). Run-time overrides may only make a policy safer. `run_eval`, `agent_chat`, `fire_trigger` and (outside `real`) `probe_project_mcp` and sub-agent calls are always blocked in eval sessions. No approval row is ever created for an eval session.
- **Agent evals: transcripts are stored redacted** (`redactSecrets` before capping); the conversation subject is the only thing graders, the judge and the console read. Agent case code stays in `src/evals/runner/agentCaseRunner.ts` and never touches the stage runner; the dispatcher `caseRunner.ts` picks by target kind.
- **The agent sample must stay judge-free.** `examples/evals/support-sample.*` runs in `script` mode with no `rubric` or `goal_reached` grader and read-only tools; `tests/examples.agentEvals.test.ts` checks it. `installEvalSample` writes its agent through the agent service, never as a hand-written file.
- **The run token** that authorizes the engine's callback to the Host is never logged, put in an error, a config file or a response.
- **No secret in generated engine config or results.** The judge key goes through the child process environment only. A grader error stores a code, never the provider's response body.
- **Telemetry stays off.** The engine child gets the `PROMPTFOO_DISABLE_*` flags and the network guard; do not remove either.
- **No test calls a real model or the network.** Tests use `FakeEngine`, fake runners and the local HTTP fixtures. The real-engine smoke test is opt-in (`STAGEFLOW_EVALS_SMOKE=1 npx vitest run tests/evals.promptfoo.smoke.test.ts`).
- **All eval and dataset writes go through the write path** (`src/config/writeEval.ts`, `writeDataset.ts`, atomic with a base hash and `FILE_CHANGED`). Do not write those files anywhere else.
- **Failure sorting is manual, suggestion-only and its own code.** `src/evals/triage/` (classifiers behind `FailureClassifier`: `jev` over injectable `fetch`, `judge` over the simulator's one-shot model call) never touches the promptfoo engine, never runs after a run on its own, and never tags: only an accept writes tags, through `putEvalReview`. The numbers (`summary`) are computed in `src/evals/read/suggestions.ts`, not the UI. Bump `TRIAGE_PROMPT_VERSION` (not the rubric or simulator constants) when the questions, bucket criteria or judge prompt in `triage/prompts.ts` change. The Jev model id is pinned (`JEV_MODEL_ID`, never `jev-latest`) and recorded on every suggestion; Jev spend is `triage_cost_usd`, outside the run's cost cap. The TypeSafe key comes from `credentials.ts` only (stored `typesafe` credential, then `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY`) and is never logged, returned, stored or put in an error; status reports source names only. The classifier state is the bounded, redacted `stateBuilder.ts` text (24k chars). Tests use the local System One fixture (`tests/helpers/systemOneFixture.ts`); the real endpoint is opt-in (`STAGEFLOW_JEV_SMOKE=1 npx vitest run tests/evals.jev.smoke.test.ts`). Suggestions are deleted with their run (cascade); keep `docs/evals.md` ("Sort failures automatically" and its privacy lines) in sync.
- **Judge-capable providers** are the rows of `JUDGE_PROVIDERS` (`anthropic`, `openai`, `openrouter`). Add one only after verifying its mapping against the engine.
- **Finding codes are public.** Keep `docs/yaml-catalog.md` (eval and dataset tables) in sync when you add or rename one. Update `docs/evals.md` when behavior changes, and keep `examples/evals/` and `tests/fixtures/evals/` in sync. The agent chapter is "Evals for agents" in `docs/evals.md`; its privacy statement must keep saying that a simulator model and the judge read the conversation, that `real` tools act on the project, and that eval sessions are hidden.

## Documentation

- Public docs index: [docs/README.md](docs/README.md)
- Human contributor flow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Planning artifacts under `docs/plans/`, `docs/ideation/`, and `docs/adr/` are local-only (gitignored), as are `docs/compare-conductor.md` and `docs/migrate-real-oss-issue-pipeline.md`

## Positioning (public copy)

When writing user-facing text, avoid framing Stageflow as an SDLC-only tool. Lead with **configurable stages / pipelines**; cite SDLC as one example among others (releases, research, ops, etc.).

<!-- agenttrail -->
## agenttrail plan convention
Maintain PLAN.md as the living plan. It is read by the project OWNER, not by you — write it for them.
- nodes are COMPONENTS of the system being built (`## Plain-language name {#id}`), not phases or sprints; keep the map at 5-9 components regardless of repo size — grow tasks, not cards, and split a component only when one agent could no longer own it for a session
- naming rule: titles are verb-led, plain-language, and CONCRETE — the owner can tell when it is done ("Read alerts out loud", "Watch the repo"). Never engineer-speak ("fs watcher + activity signal") and never vague vibes ("Decide what matters"); put the engineer phrasing on a `tech:` line under the heading
- tasks inside a component: `- [ ] Plain outcome {#id}`, optional indented `tech:` line beneath; mark a task `[~]` BEFORE you start it and save PLAN.md immediately — this drives the live in-progress view; flip it to `[x]` the moment it completes, `[!]` if stuck (clear once unblocked). Never batch plan updates for the end of the session
- when you mark a task `[~]`, add an indented `by: <your name>` line under it (claude, codex, cursor, …) and leave it there when done — it is the record of who did what
- edges under a component heading: `needs: [id, id]` = must come after those components; `links: [id, id]` = interconnected with / talks to
- `files: [src/audio/**, config.py]` under a component declares which paths it owns — keep it current; it is how the live view knows which component you are really working in, including when you revisit finished work
- `{#id}`s are stable — never rename, only add or remove nodes
- open tasks carry an indented `from:` line naming their provenance — `from: agent` when YOU are declaring it as your own imminent build intent (the owner corrects these on sight if wrong), `from: roadmap` when it comes from planning documents (durable intent, backloggable); omit when neither
- new work NEVER creates a component by default: it lands as your session todos plus tasks under the component whose files it touches. Add a NEW component only when the system grows a durable new part. Durable is not a prediction — test it NOW: something else already depends on it (load-bearing), deleting it would change what the product does, you can name a plausible second task for it, and it owns files no component claims. Record the addition under `## decisions`. Time corrects mistakes cheaply: merge a card back into its neighbor if no second change ever comes; promote a task to a card when work keeps clustering in files its siblings never touch. Remove a component only when that part is deleted from the product
- before ending a session, graduate your plan-worthy completed todos into PLAN.md as `[x]` tasks (with `by:`) — housekeeping todos stay out of the plan
- record any plan-affecting decision under `## decisions` BEFORE implementing it
