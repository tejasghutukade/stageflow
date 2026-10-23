# 15: MCP tools

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 13

## Why this story exists

Agents and other tools run Stageflow through MCP. Evals must be listable, runnable and readable the same way (A5, the repo's capability-parity pattern).

## Read first

- [api-cli-mcp.md](../../specs/evals-api-cli-mcp.md): "MCP tools" (names, inputs, outputs).
- `src/mcp/triggerTools.ts` (structure, zod schemas, `textResult`, audit writes, `McpToolDeps`), `src/mcp/deps.ts`, `src/mcp/tools.ts` (where tool groups are registered), `src/mcp/waitRun.ts` (wait semantics to mimic for `wait: true`), `src/mcp/toolResults.ts`.
- Tests: `tests/mcp.triggerTools.test.ts`.
- Story 13's read helpers in `src/evals/read/` (reuse; do not recompute).

## Decisions already made (do not revisit)

The ten tools and their inputs/outputs are fixed in api-cli-mcp.md. No MCP tool writes eval or dataset files in release 1. `run_eval` defaults to `wait: false`; with `wait: true` it returns the finished `EvalRunDetail` or `{ eval_run_id, status: "timeout" }` after `timeout_ms` (default 600000, max 1800000). Errors use the same `textResult(..., true)` convention as trigger tools, with the documented `code`s. The manager's `started_via` is `"mcp"`.

## What to build

1. **`src/mcp/evalTools.ts`:** `registerEvalTools(server, deps)` registering `list_evals`, `get_eval`, `validate_eval`, `run_eval`, `get_eval_run`, `list_eval_runs`, `get_eval_results`, `get_eval_result`, `cancel_eval_run`, `compare_eval_runs`, with zod input schemas and descriptions written for an agent (what it does, what it costs, that runs call a model and spend money, that `wait: false` returns immediately).
2. Register the group where trigger tools are registered; add `evalRunManager` (and anything else needed) to `McpToolDeps` and wherever deps are constructed (find with the story 09 wiring).
3. Tests with the MCP test harness used for trigger tools: each tool's success output equals the corresponding API object; `run_eval` with `wait: true` returns the finished detail (FakeEngine); with a short timeout returns `status: "timeout"`; `run_eval` on an invalid eval returns an error result with findings; `cancel_eval_run`; unknown ids give `EVAL_NOT_FOUND`/`EVAL_RUN_NOT_FOUND`.
4. If the repo has a documented or tested list of tool names (search `tests/` and `docs/mcp.md` for an enumeration of tools, for example a snapshot or count), update it.

## Acceptance

- [ ] All ten tools are registered and appear in the server's tool list (test enumerates names).
- [ ] Each tool's output shape equals the API's for the same data (shared helpers; tests compare).
- [ ] `run_eval` `wait: false` returns `{ eval_run_id }` fast; `wait: true` returns the finished detail; the timeout result is returned, not thrown.
- [ ] Tool descriptions state cost and side effects (test asserts the `run_eval` description mentions that it calls models and may cost money).
- [ ] No tool can create, update or delete eval/dataset files.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Docs and skill text (story 24).

## Open questions

_(agent fills; stop and ask the owner)_
