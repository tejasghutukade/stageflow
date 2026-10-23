# Evals for agents (release 2): implementation plan

Status: **approved 2026-10-22 (section 10).** Builds on [evals.md](evals.md) (release 1, built).

Written against Stageflow 0.38.0 plus the merged evals work. Facts about agents come from `docs/agent-definition.md`, `agent-runtime.md`, `agent-observability.md`, `src/agents/{service,sessions,chatTurn}.ts`. Facts about evals come from the merged `src/evals/` code.

## 1. Goal

An author can pick an **agent** as the target of an eval, give it **scenarios** (a scripted or simulated user), run them with repeats, grade **the whole conversation and the tool calls**, and read the same stats and compare views as for stages. Same files, same run store, same screens, same CLI and MCP.

Release 1 already reserved the seams (target is a tagged reference, tables are target-neutral, graders read a normalized subject, engine sits behind an interface). This plan fills them in. It must not change any stage eval behavior.

## 2. What is different about an agent (and why it is the hard part)

| Stage case | Agent case |
|---|---|
| One input, one run, one envelope | A **conversation**: several user turns, several agent turns |
| The "user" is the dataset row | The user must be **played**: scripted messages or a simulated user model |
| Output is JSON that matches a schema | Output is a **transcript + tool calls + final state** |
| Tools are the stage's own, run in a throwaway run | Tools have **real side effects** (write files, bash, MCP servers, Stageflow tools, sub-agents) |
| A person never needs to act mid-run (gate = failure) | **Approvals** (`ask_first`) pause the turn for a person |
| Pinned by stage definition hash | Pinned by **agent revision**, but sessions always open on the *current* revision |
| Cost = one stage run | Cost = N agent turns + N simulator calls + judge calls |

Four problems need real design: **running the user**, **tool safety**, **approvals**, **revision pinning**. The rest is extension work.

## 3. Decisions proposed (recommended answer in bold; change any before build)

| # | Decision |
|---|---|
| G1 | **The Host plays the whole conversation.** The promptfoo provider calls one Host route (`run-case`) as today; the Host runs the conversation loop and returns the transcript. promptfoo never sees turns. Reason: promptfoo's simulated user is cloud-only, and keeping turn logic in the Host keeps the engine swappable. |
| G2 | **Two user modes.** `script`: fixed list of user messages (deterministic, cheap, good for regressions). `simulated`: a persona + goal + facts the user reveals over turns, played by a model (the *simulator*), with a hard turn cap and an end condition. Both ship; `script` first. |
| G3 | **Simulator model = a setting on the eval** (`defaults.user_model`), defaulting to the judge model. Same provider restrictions as judges (three verified providers) unless we verify more. Rubric prompt version style: the simulator prompt gets a `SIMULATOR_PROMPT_VERSION` in the snapshot and fingerprint. |
| G4 | **Eval sessions are real agent sessions with `source: "eval"`**, hidden from agent session lists, inbox, counts and retention, exactly like stage eval runs (`origin='eval'`). Spans, tokens and cost come for free from the existing store. |
| G5 | **Pin the revision explicitly.** Add an optional `revision` (and an in-memory definition override for model) to `openSession`, so an eval runs the revision it records, not "current". The eval run stores revision number and definition hash. |
| G6 | **Tools are locked down by an eval tool policy**, set on the eval: `tools: real \| read_only \| mocked`. **Default `read_only`**: tools whose risk is `read` run; write, destructive and external tools (and any tool not provably read-only: bash, write, edit, arbitrary MCP tools) are **replaced by a stub that returns a configured canned result or "not executed in eval"** and is recorded as a tool call. `real` needs an explicit flag and shows a warning in the UI and CLI. `mocked` lets a case supply tool results (`case.input.tool_mocks`). |
| G7 | **Approvals in evals are never decided by a person.** Policy on the eval: `approvals: deny \| auto_approve_read \| record_only`. Default `record_only`: the call is recorded as "would ask first", treated as denied for the model, and graders can assert on it (`tool_asked_first`). No pending approval ever reaches the Inbox. |
| G8 | **Side-effect channels are off.** No channel sends, no schedules, no web-chat, no OTLP push, no groundedness judge call (it is a grader now). An eval session never delivers anything outside the Host. |
| G9 | **Limits come from the eval, not the agent**, but never exceed them silently: the eval's `max_turns`, per-case timeout and cost cap apply; the agent's own `limits` are overridden for eval sessions and the override is shown in the config snapshot. |
| G10 | **Subject for graders is a tagged union**, `kind: "envelope" \| "conversation"`. Existing graders keep working on the envelope. Conversation subject: `messages[]`, `tool_calls[]` (name, args, result summary, status, asked-first outcome), `final_reply`, `turns`, usage. Graders that cannot apply to a kind report `EVAL_GRADER_NOT_APPLICABLE` at validation, not at run time. |
| G11 | **Multi-turn judge reads a bounded transcript** (turn cap, per-message char cap, tool results truncated) and the rubric prompt version is bumped for the conversation variant. |
| G12 | **Agent eval files use the same `*.eval.yaml`.** `target: { kind: agent, agent: <id> }`; `revision` is recorded in the snapshot, not authored (eval always runs the current revision unless the run dialog pins one). |
| G13 | **No promptfoo dependency growth.** Conversation grading reuses the existing assertion kinds (`javascript`, `llm-rubric`) through the existing generator; no new promptfoo feature is used. |

## 4. File format changes

All additive, all behind `target.kind: agent`. `docs/specs/evals-file-schema.md` and `evals-dataset-format.md` get a "release 2" section; `docs/yaml-catalog.md` tables follow.

### Eval file

```yaml
id: support-agent-basics
name: Support agent basics
type: capability
target: { kind: agent, agent: support }       # agents/support.agent.yaml
dataset: ./support-scenarios.dataset.jsonl
defaults:
  repeats: 3
  pass_threshold: 0.8
  max_cost_usd: 3
  concurrency: 2                              # agent runs are heavier; lower default
  judge: openrouter/...
  user_model: openrouter/...                  # simulator (default: judge)
conversation:
  mode: simulated                             # script | simulated (case can override)
  max_turns: 8                                # user turns per case
  turn_timeout_ms: 120000
  tools: read_only                            # real | read_only | mocked
  approvals: record_only                      # deny | auto_approve_read | record_only
graders: [...]                                # existing types + new conversation types below
```

### Case (dataset row)

```json
{"id":"s001","title":"Refund request, angry customer",
 "input":{
   "persona":"Annoyed Pro customer, short sentences.",
   "goal":"Get a refund for a double charge on invoice INV-2093.",
   "opening":"I was charged twice and I want my money back.",
   "facts":["invoice INV-2093","charged on the 3rd","Pro plan"],
   "script":null,
   "tool_mocks":{"billing.lookup_invoice":{"result":{"status":"duplicate"}}}},
 "expected":{"outcome":"escalated_to_human","tools":["billing.lookup_invoice"],"forbidden_tools":["billing.refund"]},
 "tags":["billing"]}
```

- `script` mode: `input.script` is the list of user messages; `opening`/`persona`/`goal` are ignored.
- `simulated` mode: `opening`, `persona`, `goal` required; `facts` are revealed only when the agent asks or it is natural.
- CSV import maps columns to `input.opening`, `input.goal`, `input.persona`, and `expected.*` as today; `script` and `tool_mocks` are JSON/JSONL only.

### New grader types

| Type | Reads | Example |
|---|---|---|
| `tool_calls` | `tool_calls[]` | called `billing.lookup_invoice` at least once; never called `billing.refund`; call count ≤ 3; arguments match a field check |
| `conversation_check` | `messages[]`, `turns` | code/field check: turns ≤ N, reply count, **at most one question per agent turn**, final reply contains X |
| `goal_reached` | whole transcript | rubric specialized for "did the agent achieve `input.goal`"; pass/fail with the judge |
| `rubric` (existing) | whole transcript for agents | quality, tone, honesty; scale pass_fail or 1–5 |
| `code` (existing) | `output` is the conversation subject | arbitrary JS over transcript |
| `groundedness` | spans/evidence | reuse the agent's groundedness prompt as a grader (optional, later story) |
| `field` / `reference` (existing) | `final_reply`, `tool_calls` via paths | `output.final_reply`, `output.tool_calls[*].name` |

Latency/cost budgets (`budget`) work unchanged (per conversation).

## 5. Architecture changes

```
dataset row ──▶ EvalRunManager ──▶ EvalEngine (promptfoo) ──provider──▶ Host /api/evals/internal/run-case
                                                                         │ kind=agent
                                                                         ▼
                                              agentCaseRunner  (new, src/evals/runner/agentCaseRunner.ts)
                                                 ├─ opens eval session (source "eval", pinned revision, eval limits)
                                                 ├─ user driver: ScriptDriver | SimulatedUser (model)
                                                 ├─ loop: user message ─▶ AgentChatController.send ─▶ reply
                                                 ├─ tool gate wrapper: policy real/read_only/mocked, approvals record_only
                                                 ├─ stop: goal marker, max_turns, timeout, budget, cancel
                                                 └─ build conversation Subject from messages + spans
                                                        ▼
                                              RunCaseResult { output: conversation subject, usage, latency }
```

Reused as is: manager (lifecycle, cost limit, cancel, one run at a time), run tokens, snapshot/fingerprint, scoring/stats/compare, result tables, read models, API, CLI, MCP, UI shells.

Changed:

- **Types** (`types.ts`): `EvalTarget`/`TargetRef` become unions; `CaseOutput` gains `kind: "conversation"`; `RunCaseResult.ok` carries `sessionId` next to `stageRunId` (generalized to `subjectRef`).
- **Loader/validator** (`loadEval.ts`, `validateEval.ts`): accept `kind: agent`; resolve agent id (exists, not archived, enabled-or-warn); validate `conversation.*`; validate grader/target compatibility; case input shape per mode (not a stage `io.input` schema).
- **Plan/snapshot** (`plan.ts`, `snapshot.ts`): target version = agent revision + definition hash; snapshot records the *effective* definition, tool policy, approval policy, simulator model and prompt version. Fingerprint covers those.
- **Stage case runner** stays untouched; the internal route dispatches on `kind`.
- **Agent service** (`openSession`): optional `revision` pin and eval-only `source`; eval sessions excluded from list queries; limits override for eval sessions.
- **Tool gate**: an eval-aware wrapper around the existing gate (`agent-runtime.md#the-gate`). Cannot weaken the gate for real sessions; applies only when the session source is `eval`.
- **Judge/rubric**: conversation variant of the rubric prompt, `RUBRIC_PROMPT_VERSION` bumped; simulator prompt is a new versioned constant.
- **Stats**: no new formulas except optional per-case `turns` and `tool_calls` summary columns on results, aggregated in `stats.ts` (mean turns, mean tool calls). Hand-computed tests as the rules require.
- **Migration**: add `eval_results.subject_ref` (nullable) and keep `stage_run_id`; or a single generalized column per the note in `evals-result-schema.md`. One migration; stage rows backfilled.
- **Docs/skills/AGENTS.md** updated; AGENTS.md rule "graders read a normalized subject" now has two subjects.

## 6. UI

- New eval wizard: the **Agent** pill in `newEval/SetupStep.tsx` becomes live. Step "Target" shows an agent picker (name, model, revision, tool summary with risk badges).
- Setup shows **Conversation** card: mode, max turns, user model, tool policy (with the `real` warning), approval policy.
- **Case editor**: scenario form (persona, goal, opening, facts, script messages, tool mocks) instead of the stage input form. Upload dialog maps CSV columns to scenario fields.
- **Try on one case** works for agents: shows the transcript live, tool calls, grades.
- **Results**: result drawer shows a **transcript view** (turns, tool call chips with args/result/asked-first, spans link to the existing Agent run page `Waterfall`). Overview adds mean turns and tool calls tiles. Everything else (compare, flaky, failure tags) unchanged.
- Entry points: "Evaluate" on an agent page and agent session page ("Add this session as a case").
- Follow `ui/AGENTS.md` and Astryx rules. Needs a Wonder design pass for: Conversation card, scenario editor, transcript result view, tool-policy warning. (Designs are a story, not assumed.)

## 7. Story breakdown

Same pattern as release 1: `docs/tickets/evals-agents/NN-*.md`, built by subagents in worktrees. Sequenced so stage evals never regress.

| # | Story | Blocked by | Parallel with |
|---|---|---|---|
| A00 | **Pre-build verification** (no product code): how to run a conversation in-process without a channel; session with explicit revision/definition override; how the tool gate can be wrapped for `source: eval`; which tools are provably read-only (Stageflow tool risks, builtin `read` group, MCP tools are *unknown*); how spans expose tool args/results at `capture: metadata` (can the eval force `full` for its own sessions?); simulated user prompt quality probe with a stub model; promptfoo needs nothing new; cost of a typical 6-turn conversation | none | none |
| A01 | Contracts: file schema, dataset, result and engine-interface "release 2" sections, `docs/specs/evals-agents-*.md` if needed | A00 | |
| A02 | Types + loader/validator for `kind: agent`, `conversation:` block, new grader configs, case shapes; findings codes; tests with fixtures | A01 | A03, A04 |
| A03 | Agent service changes: `openSession` revision pin, `source: "eval"`, hidden from lists/counts/retention, eval limits override, no channel/schedule/OTLP/groundedness side effects | A01 | A02, A04 |
| A04 | Migration + store: `subject_ref`, agent target columns usage, snapshot/fingerprint for agents | A01 | A02, A03 |
| A05 | **Tool policy + approval policy wrapper** (`real`/`read_only`/`mocked`, `record_only`), tool call recording, risk classification table, tests that no write tool runs in `read_only` | A03 | A06 |
| A06 | **User drivers**: `ScriptDriver`, `SimulatedUser` (prompt, versioned, stop marker, fact reveal, turn cap), fake model for tests | A01 | A05 |
| A07 | **`agentCaseRunner`** + internal route dispatch; transcript → conversation subject; budget, timeout, cancel, needs-nothing; `FakeAgentBackend` tests | A03, A05, A06 | |
| A08 | Graders: `tool_calls`, `conversation_check`, `goal_reached`, conversation-aware `rubric`/`code`/`field`/`reference`; rubric prompt version bump; normalize in promptfoo generator | A02, A07 | A09 |
| A09 | Stats/read models: turns and tool-call aggregates, result detail with transcript, compare, list; API field additions | A04, A07 | A08 |
| A10 | API/CLI/MCP: agent targets accepted everywhere, `sf eval new --agent`, JSON shapes, docs | A08, A09 | A11 |
| A11 | UI design pass (Wonder): Conversation card, scenario editor, transcript view, warnings | A01 | A02–A09 |
| A12 | UI build: agent picker, conversation card, scenario case editor, upload mapping, try-one, transcript results | A10, A11 | |
| A13 | Entry points: Evaluate from agent page, add-session-as-case | A12 | |
| A14 | Sample agent eval (`examples/evals/` agent + scenarios, no judge needed in `script` mode), docs (`docs/evals.md` agent chapter, console-evals, yaml-catalog), skills, AGENTS.md | A10 | A12 |
| A15 | E2E + release: real-promptfoo smoke with a fake agent backend, full suites, Docker walkthrough, final report | all | |

Critical path: A00 → A01 → A03 → A05 → A07 → A08 → A10 → A12 → A15. A02, A04, A06, A11 run in parallel with it. Roughly 16 stories vs 26 in release 1 because the shell exists.

## 8. Risks

1. **Side effects (highest).** An eval that really runs `bash`, `write` or an MCP tool against the author's project is dangerous. G6/G7 default to safe; `real` is opt-in and loud. Unknown MCP tools are treated as unsafe until the author lists them as read-only (`conversation.read_only_tools`).
2. **Simulated user quality and cost.** A weak simulator makes results noise. Mitigations: `script` mode first; simulator prompt versioned and in the fingerprint; transcripts are always viewable; judge and user model are separate settings.
3. **Non-determinism grows with turns.** Repeats matter more; default repeats 3 stays, doc must say pass^k on conversations is stricter.
4. **Cost.** A 6-turn case may cost 10–20× a stage case. The estimate and cost cap must count simulator calls and judge reading a transcript. Default `max_cost_usd` and `concurrency` are lower.
5. **Capacity.** Agent turns share the Host's model slots; one eval run at a time stays (P9).
6. **Revision drift.** If the agent changes during a run, results would mix revisions. The run pins the revision at start (G5) and the manager refuses to start on an agent with parse issues.
7. **Agent features that do not fit evals:** channels, schedules, web chat, always-on, sub-agents. Sub-agents run (their cost is on their own session; the runner sums them), but their tools obey the same policy. Channel/schedule are simply ignored.
8. **Tool results in transcripts may contain secrets.** Transcript storage uses the same redaction as agent spans; eval results store the redacted text only.
9. **Privacy statement** in docs must add: a simulator model and the judge read the conversation; tool calls in `real` mode act on the project.

## 9. Out of scope (release 2)

Voice and channel-specific evals, red-teaming and adversarial generators, production/online evals, auto-generated scenarios, multi-agent topologies as a target, human labelling/calibration, scheduled/CI runs (CLI exit codes already work), agent file edits from the console beyond what release 1 does for evals.

## 10. Owner decisions (confirmed 2026-10-22: all recommendations accepted)

1. Tool safety default is `read_only`; everything not provably read-only is stubbed and recorded. `real` is an explicit, loud opt-in.
2. Both user modes ship in release 2; `script` lands first.
3. Eval sessions are hidden everywhere (lists, inbox, counts, retention).
4. The simulator model uses the judge provider list (anthropic, openai, openrouter) unless more are verified.
5. A run uses the agent's current revision at start; the run dialog does not offer older revisions in release 2.
6. Build starts with A00 (verification, no product code), then A01 to A15 in dependency order, by subagents. Stories live in `docs/tickets/evals-agents/`.

### Decisions added after A00 (2026-10-22, taken as recommended defaults; owner may overturn)

7. **Disabled agents can be evaluated** (authors evaluate before enabling): eval sessions bypass `enabled`, and validation shows a warning finding, not an error. Archived agents are an error.
8. **`mocked` fidelity:** canned result delivered as an error-flagged tool result carrying the canned text (Pi can only block with a reason). Documented as approximate.
9. **A `SimulatorModel` port** returning text plus tokens and cost is added (A06); simulator cost counts against the eval cost limit.
10. **`run_eval`, `agent_chat`, `fire_trigger`, `probe_project_mcp` and `agent:*` sub-agent calls are always blocked** under `read_only` and `mocked`; under `real` only `run_eval`, `agent_chat` and `fire_trigger` stay blocked (no recursion, no triggers).
11. **Separate `CONVERSATION_RUBRIC_PROMPT_VERSION`** (stage fingerprints stay comparable). Real tools need `allow_real_tools` (YAML) / `--allow-real-tools`; run-time overrides may only make a policy safer.
12. A00's "Recommended plan changes" (verification doc) are adopted as the plan; stories follow them. `sf eval new --agent` is dropped: agent targets are accepted by validate/run/show/list; eval files are authored in the console or by hand.
13. A01 open items accepted as written in the contracts: agent defaults concurrency 2, max_cost_usd 1, max_turns 8, turn timeout 120 s, mode script; agent failures reuse `stage_failed` (no CHECK change); real tools need both file `allow_real_tools` and per-run consent; cost cap checked before a case starts (overshoot possible, documented); `mocked` as in 8; simulator cost may be estimated (chars/4) when the provider reports no usage.
