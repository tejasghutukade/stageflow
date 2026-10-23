# A14: Sample agent eval, docs, skills, AGENTS.md

**Epic:** [Evals for agents](../../specs/evals-agents.md) · **Status:** done (branch worktree-agent-ab40d771d3fbfd735) · **Blocked by:** A10

## Why this story exists

A feature nobody can learn is not shipped. Release 1 shipped `examples/evals/` (a stage sample), `docs/evals.md`, `docs/console-evals.md`, skill text and the AGENTS.md rules. This story adds the agent chapter to each, ships a sample agent eval that runs in `script` mode with **no judge model** (plan A14), and records the new contributor rules (two subjects, tool safety, hidden eval sessions).

## Read first

- `docs/specs/evals-agents-verification.md` (A00 results; if a fact contradicts this story, the verification wins and you note it).
- [Plan](../../specs/evals-agents.md) section 4, G2, G6, G7, G8, section 8 (risks, privacy statement 9), section 9 (out of scope); the merged code for CLI flags and JSON shapes (the code and final specs win over this story).
- Release 1 story 24 (`docs/tickets/evals/24-docs-example-skills.md`) for style and rules. Existing pages to extend: `docs/evals.md` (sections "Writing an eval", "Datasets", "Running an eval", "Reading results", "Privacy and trust", "Not built {#not-built}", "Troubleshooting", "HTTP API"), `docs/console-evals.md`, `docs/yaml-catalog.md` (eval and dataset tables), `docs/cli-reference.md`, `docs/mcp.md`, `docs/ci.md`, `docs/glossary.md`, `docs/agents.md`, `docs/agent-runtime.md`, `docs/agent-observability.md` (mention hidden eval sessions), `docs/README.md`, `docs/environment-variables.md`, `docs/data-directory.md`.
- Sample plumbing: `examples/evals/` (README, `critique-sample.*`), `src/config/installEvalSample.ts` (`EVAL_SAMPLE_FILES`, `resolveEvalSampleDir`, `installEvalSample`, `rewriteEvalPaths`), `src/config/seededCatalog.ts`, the sample install route in `src/server/evalRoutes.ts` (`handleSampleInstall`), `docs/agent-definition.md` (minimal agent file), `tests/examples.evals.test.ts`.
- Skills: `skills/stageflow/SKILL.md`, `skills/stageflow/references/evals.md`, `skills/stageflow/references/control-surface.md`, `skills/stageflow-author/SKILL.md`, `skills/stageflow-run/SKILL.md`, `docs/skills-suite.md` (size/format limits), any tests that snapshot skill text (`grep -rn "skills/" tests`).

## Decisions already made (do not revisit)

- The sample is **offline-friendly and judge-free**: `script` mode, graders only `tool_calls`, `conversation_check`, `field`/`reference`/`code` (no `rubric`, no `goal_reached`). It still calls the agent's model (a normal agent turn), so it needs a configured default model; docs say so, like the stage sample.
- Sample files in `examples/evals/`, flat (the release 1 convention): `support-sample.agent.yaml` (id `support_sample`; agents are created disabled, so the install step enables it through the agent service, and the docs say how to do it by hand), `support-sample.eval.yaml`, `support-sample.dataset.jsonl`, and a section in `examples/evals/README.md`. The agent has **read-only tools only** (no `bash`, no `write`) plus nothing that asks first, so the sample is safe even if an author flips the policy to `real`.
- Docs describe what the product does, including honest statistics for conversations (pass^k is stricter, repeats matter more, simulated users add noise) and what is not built (plan section 9). Positioning rule from `AGENTS.md`: lead with configurable stages/agents and evals as a general quality tool.
- **Privacy statement (required):** a simulator model and the judge read the conversation; case inputs go to the agent's model as a normal agent turn; tool calls in `real` mode act on the project; by default write, shell and unlisted tools are stubbed and recorded; nothing is sent to promptfoo's services; transcripts store redacted text only; eval sessions are hidden from agent lists, Inbox, counts and retention-visible views but remain readable by id.

## What to build

1. **Sample files:** `examples/evals/support-sample.agent.yaml` (small support-style agent, instructions to answer using a tiny built-in set of facts in its instructions, read-only tool group), `support-sample.dataset.jsonl` (6 scenarios in `script` mode with `expected.tools` and `forbidden_tools`, including one that tempts the agent to call a forbidden tool, one that needs a clarifying question, one that should be declined), `support-sample.eval.yaml` (id `support-sample`, `type: capability`, `conversation: { mode: script, max_turns: 4, tools: read_only, approvals: record_only }`, `defaults: repeats 2, pass_threshold 0.8, max_cost_usd 1, concurrency 2`, graders: `no-forbidden-tools` (tool_calls, must_pass), `replies-in-time` (conversation_check turns), `one-question-per-turn` (conversation_check), `mentions-the-fact` (reference/field on `final_reply`)). Add a README section: what it shows, how to run (`sf validate`, `sf eval engine install`, `sf eval run support-sample`), what to expect, and how to turn it into a simulated eval by adding `persona`, `goal`, `user_model` and a `goal_reached` grader.
2. **Install path:** extend `installEvalSample` and the sample install route with a `kind: "agent"` sample that writes the agent file into the project's `agents/` directory (through the agent file write path, not by hand-written YAML: see `src/agents/service.ts` `create`/`save`), the eval into `evals/`, the dataset into `datasets/`, rewrites paths, and fails with a clear message (not `eval.target_unresolved`) if the project has no default model. Keep the stage sample behavior untouched. Console button wiring is A12's pattern; here add only the API/helper and a test.
3. **Tests:** extend `tests/examples.evals.test.ts` (or a sibling `tests/examples.agentEvals.test.ts`): the agent eval loads with no errors against the sample agent, the dataset has 6 valid scenarios, `installEvalSample` into a temp project yields resolvable paths; `sf validate --strict` on `examples/evals/` still passes.
4. **User docs:** `docs/evals.md` new chapter "Evals for agents" (concepts: scenario, driver, simulator, conversation subject, tool policy, approval policy; quick start with the sample; the YAML with every `conversation` field; dataset scenario shape and CSV limits; the three new graders plus how existing ones read a conversation; running and the `allow_real_tools` consent; reading results and the transcript view; cost and limits; privacy; troubleshooting: agent disabled/archived, simulator model unsupported, tool stubbed, would-ask-first, revision changed during run; not built). `docs/console-evals.md` agent screens in ui-map order without design-file references. Update `docs/yaml-catalog.md` eval/dataset tables and finding codes, `docs/cli-reference.md`, `docs/mcp.md`, `docs/ci.md` (exit codes unchanged), `docs/glossary.md` (Scenario, Driver, Simulator, Conversation subject, Tool policy), `docs/agents.md` and `docs/agent-observability.md` (eval sessions are hidden and where to see them), `docs/README.md`. Link, do not duplicate.
5. **Skills:** teach `stageflow` (router and `references/evals.md`), `stageflow-author` and `stageflow-run` that evals can target agents: when to run `sf eval validate`/`sf eval run --json` on an agent eval, how to read the conversation outcome fields, that runs cost more (agent + simulator + judge), the tool-safety default and `--allow-real-tools`, and where the docs are. Follow `docs/skills-suite.md` limits; update skill snapshot tests if any.
6. **`AGENTS.md`:** in the Evals section state the new rules: graders read a normalized subject and there are now two kinds (`envelope`, `conversation`); eval sessions are agent sessions with `source: "eval"` and are excluded from every operator-facing list/count/inbox/retention path (use `includeEval` only in eval code); the eval gate fails closed and cannot weaken the real gate; `read_only` is the default tool policy and `real` needs explicit consent; transcripts are stored redacted; bump `SIMULATOR_PROMPT_VERSION` and `CONVERSATION_RUBRIC_PROMPT_VERSION` when those prompts change; `src/evals/runner/` split (stage vs agent). Update the repository/`src/` map rows for `evals/` and `agents/`.

## Acceptance

- [x] `examples/evals/` has the agent sample; `sf validate --strict` on it passes; the loader/install test passes.
- [ ] A fresh project can run `sf eval run support-sample` with a configured default model (manual; recorded by the owner unless credentials are available).
- [x] Every new or changed doc exists and relative links resolve (run the docs link check if the repo has one, else script it and report).
- [x] The privacy statement and the "not built" list appear exactly as decided above.
- [x] CLI flags and JSON in docs match the implementation (run each documented command against a fake Host or read the tests; no invented flags, no `sf eval new` unless A10 built it).
- [x] Skills mention agent evals accurately; skill tests pass.
- [x] `AGENTS.md` has the new rules and updated tables.
- [x] No stage eval behavior changes; existing eval tests untouched.
- [x] `npm test` and `npm run typecheck` pass (`npm run ui:test` not run: no ui/ changes here).

## Contract notes from A01 (the six specs' "Release 2: agents" sections win over any older line in this story)

- Sample values match the contract defaults: agent evals default to `concurrency` 2 and `max_cost_usd` 1; the sample writes them explicitly. The docs list the finding codes of `evals-file-schema.md` Release 2 and the exit-code/JSON additions of `evals-api-cli-mcp.md` Release 2 (`docs/ci.md`: additive fields for agent targets only).
- `reference` on agent targets defaults to `path: final_reply`, so the sample's `mentions-the-fact` grader may omit it.
- Document the two-part real-tools consent (`conversation.allow_real_tools` in the file, `--allow-real-tools` per run) and the always-blocked tools under `read_only` (sub-agent calls included).

## Out of scope

Release notes and version bump (A15), console screenshots, simulated-mode sample (documented, not shipped), `groundedness` grader docs.

## Open questions

_None blocking. See Final note for deviations._

## Final note

Branch `worktree-agent-ab40d771d3fbfd735` (based on `claude/chat-agent-research-5ab531` db7c7b3e).

Files. Sample: `examples/evals/support-sample.{agent.yaml,eval.yaml,dataset.jsonl}`, `examples/evals/README.md`. Install: `src/config/installEvalSample.ts` (`kind: "agent"`, `AGENT_EVAL_SAMPLE_*`, `EvalSampleAgents`), `src/config/atomicWrite.ts` (`SAMPLE_NO_DEFAULT_MODEL`, `SAMPLE_AGENTS_UNAVAILABLE`), `src/server/evalRoutes.ts` (`POST /api/evals/sample` body `kind`). Test: `tests/examples.agentEvals.test.ts`. Repo `stageflow.yaml` excludes the sample eval (see below). Docs: `evals.md` (chapter "Evals for agents", privacy, not built, API), `console-evals.md`, `yaml-catalog.md`, `cli-reference.md`, `mcp.md`, `ci.md`, `glossary.md`, `agents.md`, `agent-observability.md`, `data-directory.md`, `README.md`, `skills-suite.md`. Skills: `skills/stageflow/{SKILL.md,references/evals.md}`, `stageflow-author`, `stageflow-run`. `AGENTS.md`.

Decisions/deviations:
- The sample has five graders, not four: `no-forbidden-tools` (`must_call: []`, defaults for `must_not_call`) plus `reads-files-when-asked` (`must_not_call: []`, defaults for `must_call`), so both `expected.forbidden_tools` and `expected.tools` are used. `mentions-the-fact` uses `expected.mentions` (empty array for scenarios with no fact).
- `sf validate --strict` from the repo root cannot resolve `agent: support_sample` (the agent lives in a project's `agents/`, not in `examples/evals/`), so the root `stageflow.yaml` excludes `examples/evals/support-sample.eval.yaml`. The test validates the installed copy with no findings. Alternative if preferred: make the offline resolver also look beside the eval file.
- Install: no default `model` in the manifest -> `SAMPLE_NO_DEFAULT_MODEL` (422); agent created through `AgentService.create` with `web_chat: { enabled: false }` (so no public link), then enabled; `SAMPLE_EXISTS` also when an agent `support_sample` exists. The route passes the agent service only when it has `create`/`setEnabled`.
- Docs for console screens follow `evals-ui-map.md` Release 2 (A12/A13 build them concurrently); entries that depend on A13 (Evaluate button, Add as eval case, session banner, From past sessions) are described as specified.
- Link check scripted (all relative links and anchors in changed md files resolve). Full `npm test` passes (5705 tests); typecheck clean. `npm run ui:test` not run (no ui/ changes).
- Not done: manual run of `sf eval run support-sample` with real credentials (owner). MCP `model` input description still says "stage" only if A10 did not change it (not touched here).
