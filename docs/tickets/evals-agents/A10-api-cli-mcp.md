# A10: API, CLI and MCP accept agent targets

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done · **Blocked by:** A08, A09

## Why this story exists

The runtime now runs agent evals (A07) and grades them (A08), but nothing outside the manager can ask for one. The console reads and writes through HTTP; agents and CI use the CLI and MCP (release 1 capability parity). This story makes every existing eval route, `sf eval` subcommand and MCP tool accept agent targets, adds the one new read the agent picker needs, and enforces the tool-safety flag at the edges.

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- [Plan](../../specs/evals-agents.md) G6, G7, G12, section 6, risk 1; owner decisions 1 and 5.
- `docs/specs/evals-api-cli-mcp.md`, including the "Release 2: agents" section from A01 (field names, error codes, JSON shapes). It is the contract; match it exactly.
- Code: `src/server/evalRoutes.ts` (`handleEvalCreate`, `handleEvalValidate`, `handleTry`, `handleDraftEstimate`, `handleDelete` near line 893, the start-run handler, dataset handlers `handleDatasetList/Create/Preview`, `handleCandidates`, registration at line ~1294), `src/evals/read/api.ts` (`buildEvalDetail`, `validateEvalText`, `planFindings`), `src/evals/read/datasets.ts` (`resolveDatasetTarget`, `inputFieldsOf`, `previewUpload`), `src/config/writeEval.ts` (`renderEvalCreateYaml`, `previewEvalUpdate`, `createEvalFile`, `updateEvalFile`), `src/config/datasetImport.ts`, `src/cli/evalCommand.ts` (`EVAL_USAGE`, subcommands), `src/cli/hostClient.ts` (`httpStartEvalRun`, `HttpStartEvalRunInput`), `src/mcp/evalTools.ts` (the ten tools), `src/agents/definitionSummary.ts` and A05's `toolRiskSummary`, `ui/src/api/types.ts` and `ui/src/api/client.ts` (typed client style). Tests: `tests/server.evalRoutes.test.ts`, `tests/cli.eval*.test.ts`, `tests/mcp.evalTools.test.ts`.

## Decisions already made (do not revisit)

- No new transport, no new run lifecycle: agent runs start through the same `POST /api/evals/:id/runs` and the same manager. Error bodies never contain secrets, URLs or stack traces.
- The tool policy is authored in the eval file (with `conversation.allow_real_tools` as the author's consent; the run flag is the second consent). A run-time override may only make a policy **safer** (`real` to `read_only`/`mocked`, `read_only` to `mocked`); it can never escalate. A file with `conversation.tools: real` is accepted by the API but a run needs explicit consent (below). Plan: "`real` needs an explicit flag and shows a warning in the UI and CLI".
- `started_via` values stay `console|cli|mcp`. MCP still never writes eval or dataset files.
- Run overrides for agents: `repeats`, `judge`, `user_model`, `max_cost_usd`, `case_ids`, `tags`, `only_failed_from`, and the safer-only `tools` (`read_only`|`mocked`) and `approvals` (`deny`|`record_only`) with the consent flag `allow_real_tools`. The `model` override on an agent eval overrides the agent's model for that run (recorded in the snapshot).

## What to build

1. **Deps:** `EvalRoutesDeps` gets the agent service (and the agent host context for the runner is already in the manager via A07). `McpToolDeps` already carries the eval manager; add the agent service where needed.
2. **Routes** (`src/server/evalRoutes.ts` and `src/evals/read/`):
   - `POST /api/evals`, `PUT/PATCH` update, `POST /api/evals/validate`: accept and render agent definitions through `writeEval.ts` (key order for `conversation`, `defaults.user_model`, new graders); findings come from A02's validator; `derived_yaml` identical to what `createEvalFile` writes.
   - `POST /api/evals/try`: draft definition plus inline case for `kind: agent`; response `TryResult` is `{ result, stage_run_id: null, cost_usd }` with the conversation `output`, tool calls and grades inside `result` (the eval session is removed after the response, A07, so there is no session id to return).
   - `POST /api/evals/runs/estimate` and `GET /api/evals/:id/runs/estimate`: agent block from A09; includes simulator and judge-on-transcript cost.
   - Start run: validates the tool-policy consent: when the effective `conversation.tools` is `real`, the body must carry `allow_real_tools: true`, else 422 `EVAL_REAL_TOOLS_NOT_CONFIRMED` (added to `EVAL_REQUEST_ERROR_CODES` by A04); a file without `conversation.allow_real_tools: true` fails validation first (`eval.real_tools_not_allowed`). Safer overrides allowed.
   - `GET /api/evals` and `GET /api/evals/:id`: `target` carries `kind: "agent"`, agent id/name/model/revision; list filter `target_kind`; `GET /api/evals?agent=<id>` for the agent page (A13).
   - **New** `GET /api/evals/agent-targets`: agents (archived ones listed with `unavailable_reason: "archived"`, disabled ones selectable) with `id, name, model, revision, enabled, tools: [{ id, risk, class }]` (from `toolRiskSummary`), `ask_first`, `evals_count`, `issues`, `unavailable_reason`. Reads `AgentService.list`; never returns eval sessions.
   - Datasets: `GET /api/datasets/:id?eval_id=` uses `resolveDatasetTarget` for agent evals and returns `input_fields` for the scenario shape (`opening, persona, goal, facts, script, tool_mocks` with mode-specific `required`); `POST /api/datasets/preview` accepts agent field mappings (`input.opening`, `input.goal`, `input.persona`, `input.mode`, `input.facts`, `expected.outcome|tools|forbidden_tools`, `title`, `tags`); mapping `input.script` / `input.tool_mocks` returns 400 `EVAL_INVALID` with `dataset.mapping_unsupported_field`. `POST /api/datasets` also accepts `{ name, source: "sessions", target: { agent_id }, session_ids }` (A13 supplies the builder) and `GET /api/datasets/candidates?agent=<id>` exists (A13).
   - Delete run: before `deleteEvalRun`, read `store.listEvalSubjectRefs(id, "agent")` (A04) and call `AgentService.deleteEvalSessions` (A03) after the row delete, best effort like stage runs.
   - Result detail and results list return the A09 fields.
3. **Typed UI client** (`ui/src/api/types.ts`, `client.ts`): types and one function for every changed/added route (including `agent-targets`), following the existing style, so A12 has no API plumbing.
4. **CLI** (`src/cli/evalCommand.ts`, `hostClient.ts`): existing subcommands work for agent evals; `show` and `runs show` print the agent target, conversation settings and, for results, turns and tool calls; `run` gains `--user-model <model>` and `--allow-real-tools`; when the effective policy is `real` and the flag is missing the command exits with the existing usage-error code and a clear message; when it is set, print a one-line warning. `--json` documents add the agent fields exactly as in the spec; exit codes unchanged (`docs/ci.md` contract). Update `EVAL_USAGE` and the CLI tests. There is **no** `sf eval new` and `sf eval new --agent` is dropped (owner decision 12); the safer-only `tools`/`approvals` overrides are API/MCP fields, not CLI flags.
5. **MCP** (`src/mcp/evalTools.ts`): the ten tools accept and return agent targets; `run_eval` input gains `user_model` and `allow_real_tools`; descriptions state that agent runs call the agent's model, a simulator model and the judge, may cost much more than stage runs, and that tools are read-only by default; `get_eval_result` returns the conversation subject. Update any tool-name enumeration tests.
6. **Tests:** agent happy paths per route with `FakeEngine` + `FakeAgentBackend`; `FILE_CHANGED` flow with agent files; `EVAL_REAL_TOOLS_NOT_CONFIRMED`; override escalation rejected; delete removes sessions; `agent-targets` hides eval sessions and archived agents; CLI exit codes and `--json` shapes; MCP success equals API for the same data; error bodies free of secrets on a forced agent failure.

## Acceptance

- [x] Every route in the A01 spec for agents exists with the documented method, path, body, response and error codes (table-driven test).
- [x] An agent eval can be validated, created, tried on one case, estimated, run, read, compared, exported and deleted over HTTP using `FakeEngine`/`FakeAgentBackend`.
- [x] A `real`-tools eval cannot start without `allow_real_tools`; overrides cannot escalate tool or approval policy.
- [x] Deleting an agent eval run removes its eval sessions; stage run deletion unchanged.
- [x] `sf eval run <agent-eval> --json` returns the documented document and exit codes; `--allow-real-tools` and `--user-model` work; usage text updated.
- [x] MCP tools handle agent evals; `run_eval` description mentions model cost and tool safety; no MCP tool writes files.
- [x] `ui/src/api/` has the typed functions and types; `npm run ui:test` and `npm run typecheck` pass for both workspaces.
- [x] No stage eval behavior changes; existing eval route, CLI and MCP tests untouched.
- [x] `npm test`, `npm run ui:test`, `npm run typecheck` pass.

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- All field names, codes, filters (`target_kind`, `agent`, `subject_ref`) and shapes are in `evals-api-cli-mcp.md` Release 2; implement exactly those. `ResultDetail.stage_run_id` is `null` and `agent: { id, session_id }` is present for agent results.
- Stage responses must not gain any key (agent keys are absent, not `null`) except where the contract says otherwise.
- `sf eval run --json` adds `target_kind`, `agent_id`, `agent_revision`, `mean_turns`, `mean_tool_calls`, `tools_policy` for agent targets only; `docs/ci.md` is updated by A14.

## Out of scope

UI pages (A12), entry points and "add session as case" candidates (A13), user docs and skills (A14), a new `sf eval new` command.

## Open questions

_(agent fills; stop and ask the owner)_ Resolved by A01: (1) `sf eval new --agent` is dropped (owner decision 12). (2) Consent is two-part: `conversation.allow_real_tools: true` in the file and the per-run flag (`--allow-real-tools` / `allow_real_tools`), per owner decision 11; A01 asks the owner to confirm both are required.

## Final note

Branch `worktree-agent-aea7fb83672da7c3e` (based on `claude/chat-agent-research-5ab531`, A02-A09).

Files. Server: `src/server/evalRoutes.ts` (agents + `loadPrices` deps, `GET /api/evals/agent-targets`, agent estimate block, `subject_ref`, `allow_real_tools`, run overrides, session cleanup on delete, scenario dataset detail/preview, `source: "sessions"`, `candidates?agent=`), `src/server/http.ts` (wires `agents` and `defaultLoadJudgePrices`). Read: new `src/evals/read/agentTargets.ts`, `read/api.ts`, `read/datasets.ts`. Plan/manager: `src/evals/plan.ts` (`EvalOverrides` gains `user_model`, safer-only `tools`/`approvals`, `allow_real_tools`; escalation and stage-target checks; `real_tools_confirmed`), `src/evals/manager.ts` (consent check in `start`/`tryOne`, `preflightAgentStart`, agent runs now stored with `targetKind: "agent"` and `{agent_id, revision}` targetRef: A07 left `"stage"` hard-coded). Write path: `src/config/writeEval.ts`, `datasetImport.ts` (`title`/`tags` mapping for agents), new `src/config/datasetFromSessions.ts`. CLI: `evalCommand.ts`, `hostClient.ts`. MCP: `mcp/evalTools.ts`. UI: `ui/src/api/evalTypes.ts`, `evalsClient.ts` (+ narrowing fixes in 5 `redesign/evals` files so the unions compile). Tests: `tests/server.evalRoutes.agent{,Runs}.test.ts`, `tests/mcp.evalTools.agent.test.ts`, `tests/cli.evalAgent.test.ts`, `tests/config.writeEvalAgent.test.ts`, `tests/helpers/agentEvalHarness.ts`, `ui/src/api/evalsClient.agent.test.ts`.

Decisions taken inside the story:
- Consent order is validate, consent, engine check, 409: routes and MCP call `manager.preflightAgentStart` (agent evals only, no-op for stage) before `engineCheck`; `start`/`tryOne` enforce consent again. `try` takes `allow_real_tools` in the body.
- Escalation rank: tools `real < read_only < mocked`, approvals `auto_approve_read < record_only < deny`; a bad override is `EVAL_INVALID` (`eval.invalid_field`); agent-only overrides on a stage eval are `eval.conversation_not_applicable`.
- Archived agents: `AgentService.list` hides them, so `agent-targets` shows an archived agent (`unavailable_reason: "archived"`) only while an eval file still names it. `invalid` means the agent has issues or no definition.
- Preview of an upload for an agent target takes the mode from optional `eval_id` (its `conversation.mode`), default `simulated`. Default CSV mapping splits `input.facts` on `|`.
- "Finished" session for candidates/sessions source = status `open` or `closed` with no running or waiting turn; tools come from tool spans (empty when capture is off).
- Estimate prices come from the injected `loadPrices` (defaults to the judge price loader in `http.ts`); an unknown price gives `estimate_usd: null`, `estimate_basis: null`.
- `conversationView` is not used by any route (the result detail already returns the stored conversation subject); the CLI does not print per-result turns because there is no results subcommand: `runs show` prints mean turns and tool calls.
- `sf eval list` prints `Agent <id> r<revision>` from the target's fields (the list `label` stays the agent name).

Not done / for later stories: `docs/ci.md`, `docs/yaml-catalog.md`, `docs/evals.md`, skills (A14); the agent sample for `POST /api/evals/sample` (A14); the stage+agent shared-dataset warning (console only); `ConversationView` consumers. Pre-existing: none new. Full `npm test`, `npm run ui:test`, `npm run typecheck` run on the branch (see report).
