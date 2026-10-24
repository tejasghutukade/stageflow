import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveCatalogStartInput,
} from "../config/catalogRelativePath.js";
import { assertInsideProject, manifestForWrite, resolveWriteDir } from "../config/evalWriteRoots.js";
import { CompareMismatchError } from "../evals/compare.js";
import { EVAL_LIMITS, EVAL_RUN_STATUSES } from "../evals/constants.js";
import { engineStatus as promptfooEngineStatus } from "../evals/engine/promptfoo/status.js";
import { EvalRunError, type EvalRunManager } from "../evals/manager.js";
import type { EvalOverrides } from "../evals/plan.js";
import {
  buildEvalDetail,
  buildResultDetail,
  buildResultsPage,
  DEFAULT_LIMIT,
  engineCheck,
  EvalApiError,
  locateEval,
  loadAggregatedEvalList,
  listEvalRunsPage,
  MAX_LIMIT,
  runByIdOr404,
  validateEvalText,
} from "../evals/read/api.js";
import { buildCompare } from "../evals/read/compare.js";
import { buildRunDetail } from "../evals/read/runs.js";
import { EvalStoreError } from "../evals/storeError.js";
import { SUGGESTION_STATUSES, TRIAGE_MAX_LIMIT } from "../evals/triage/constants.js";
import { TriageService } from "../evals/triage/service.js";
import type { EvalRunRow } from "../evals/storeTypes.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { callerIdFromRequestAuth, getRequestAuth } from "../server/requestAuthContext.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const auditLog = rootLogger.child({ component: "audit" });

const CANCEL_WAIT_MS = 5000;
const DEFAULT_WAIT_MS = 600_000;
const MAX_WAIT_MS = 1_800_000;

const projectRootField = z
  .string()
  .optional()
  .describe("Catalog project root; omit to use the host default");

function audit(action: string, outcome: "ok" | "error", target?: string, code?: string): void {
  writeAudit(auditLog, {
    caller_id: callerIdFromRequestAuth(),
    surface: getRequestAuth()?.surface ?? "mcp",
    action,
    outcome,
    ...(target !== undefined ? { target_run_id: target } : {}),
    ...(code !== undefined ? { error_code: code } : {}),
  });
}

function errorResult(err: unknown) {
  if (err instanceof EvalApiError) {
    return textResult({ error: err.message, code: err.code, ...err.extra }, true);
  }
  if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
  if (err instanceof EvalRunError) {
    return textResult(
      { error: err.message, code: err.code, ...(err.findings ? { findings: err.findings } : {}) },
      true,
    );
  }
  if (err instanceof EvalStoreError || err instanceof CompareMismatchError) {
    return textResult({ error: err.message, code: err.code }, true);
  }
  return textResult({ error: "Internal error", code: "internal_error" }, true);
}

export function registerEvalTools(server: McpServer, deps: McpToolDeps): void {
  const { store, cwd } = deps;

  const manager = (): EvalRunManager => {
    if (deps.evalRunManager === undefined) {
      throw new EvalApiError(503, "EVAL_ENGINE_UNAVAILABLE", "Evals are not available on this Host");
    }
    return deps.evalRunManager;
  };

  const projectRootFor = async (wire: string | undefined): Promise<string> => {
    const { wireRoot } = await resolveCatalogStartInput({ store, bootCwd: cwd }, wire);
    return wireRoot.path;
  };

  const agentsInput = () => (deps.agentService !== undefined ? { agents: deps.agentService } : {});

  const runDetail = (row: EvalRunRow) =>
    buildRunDetail({ store, row, live: manager().getLive(row.evalRunId), ...agentsInput() });

  const tool = <S extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (input: z.infer<S>) => Promise<unknown>,
  ): void => {
    const run = async (input: z.infer<S>) => {
      try {
        return textResult(await handler(input));
      } catch (err) {
        return errorResult(err);
      }
    };
    server.registerTool(name, { description, inputSchema }, run as never);
  };

  tool(
    "list_evals",
    "List the evals (*.eval.yaml) in a project with target (a stage, or an agent with its revision), dataset size, last-run headline and trend. Read-only, free. Same items as GET /api/evals.",
    z.object({ project_root: projectRootField }),
    async ({ project_root }) => {
      manager();
      const { items } = await loadAggregatedEvalList({
        options: { store, bootCwd: cwd },
        wire: project_root,
        now: new Date(),
        ...agentsInput(),
      });
      return { items };
    },
  );

  tool(
    "get_eval",
    "Get one eval: parsed definition, raw YAML, file hash, validation findings, run count and last run; for an agent eval also the live agent (model, revision, tools with risk, ask-first list). Read-only, free. Same as GET /api/evals/:id. Fails EVAL_NOT_FOUND for an unknown id.",
    z.object({ eval_id: z.string(), project_root: projectRootField }),
    async ({ eval_id, project_root }) => {
      manager();
      const { projectRoot, ref } = await locateEval({ store, bootCwd: cwd }, project_root, eval_id);
      return buildEvalDetail({ store, projectRoot, absPath: ref.absPath, ...agentsInput() });
    },
  );

  tool(
    "validate_eval",
    "Validate an eval without running it: pass eval_id for a file in the catalog, or yaml for unsaved text (exactly one). Checks schema, target, dataset and graders and returns { findings }. Read-only, free, calls no model; writes no files.",
    z.object({
      eval_id: z.string().optional(),
      yaml: z.string().optional(),
      project_root: projectRootField,
    }),
    async ({ eval_id, yaml, project_root }) => {
      manager();
      if ((eval_id === undefined) === (yaml === undefined)) {
        throw new EvalApiError(400, "invalid_request", "Provide exactly one of eval_id or yaml");
      }
      const located = eval_id !== undefined ? await locateEval({ store, bootCwd: cwd }, project_root, eval_id) : undefined;
      const projectRoot = located?.projectRoot ?? (await projectRootFor(project_root));
      let evalAbs: string;
      let derived: string;
      if (located !== undefined) {
        evalAbs = located.ref.absPath;
        derived = await readFile(evalAbs, "utf8");
      } else {
        const manifest = await manifestForWrite(projectRoot);
        const dir = await resolveWriteDir(projectRoot, manifest, "evals");
        const rawId = /^id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,63})["']?\s*$/m.exec(yaml as string)?.[1];
        evalAbs = path.join(dir.absDir, `${rawId ?? "new"}.eval.yaml`);
        assertInsideProject(projectRoot, evalAbs, "eval path");
        derived = (yaml as string).endsWith("\n") ? (yaml as string) : `${yaml as string}\n`;
      }
      const { findings } = await validateEvalText({ projectRoot, evalAbs, derived, ...agentsInput() });
      return { findings };
    },
  );

  tool(
    "run_eval",
    "Run an eval: executes every case of the eval's dataset through its target (a stage, or an agent held as a conversation; repeats times each) and grades the results. This calls models and may cost real money (stage calls plus judge calls for rubric graders), bounded by max_cost_usd. Agent runs call the agent's model, a simulator model that plays the user (simulated cases) and the judge, and can cost much more than stage runs. Agent tools are read-only by default: write, shell and unlisted tools are stubbed and recorded, never executed. An eval with conversation.tools: real needs allow_real_tools true on top of allow_real_tools in the eval file, else it fails EVAL_REAL_TOOLS_NOT_CONFIRMED. Only one eval run is active per host; a second start fails EVAL_RUN_ACTIVE. With wait false (default) it returns { eval_run_id } immediately and the run continues in the background: poll get_eval_run. With wait true it blocks up to timeout_ms (default 600000, max 1800000) and returns the finished run detail, or { eval_run_id, status: \"timeout\" } if still running (the run keeps going; cancel_eval_run stops it). An invalid eval returns an error result with findings.",
    z.object({
      eval_id: z.string(),
      repeats: z.number().int().min(EVAL_LIMITS.repeats.min).max(EVAL_LIMITS.repeats.max).optional().describe("Override executions per case"),
      judge: z.string().optional().describe("Override the judge model for rubric graders"),
      model: z.string().optional().describe("Override the stage or agent model"),
      user_model: z.string().optional().describe("Agent evals: override the model that plays the simulated user"),
      allow_real_tools: z.boolean().optional().describe("Agent evals: consent to conversation.tools real; no effect on other policies"),
      tools: z.enum(["read_only", "mocked"]).optional().describe("Agent evals: run with a safer tool policy than the file (never riskier)"),
      approvals: z.enum(["deny", "record_only"]).optional().describe("Agent evals: run with a safer approval policy than the file (never riskier)"),
      max_cost_usd: z.number().positive().optional().describe("Override the cost cap in USD"),
      case_ids: z.array(z.string()).optional().describe("Run only these case ids"),
      tags: z.array(z.string()).optional().describe("Run only cases with these tags"),
      label: z.string().max(EVAL_LIMITS.labelMaxChars).optional().describe("Free-text label for the run"),
      wait: z.boolean().optional().describe("Block until finished (default false)"),
      timeout_ms: z.number().int().min(1).max(MAX_WAIT_MS).optional().describe(`Wait budget in ms when wait is true (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`),
      project_root: projectRootField,
    }),
    async (input) => {
      const evalRunManager = manager();
      const { projectRoot, ref } = await locateEval({ store, bootCwd: cwd }, input.project_root, input.eval_id);
      const overrides: EvalOverrides = {};
      if (input.user_model !== undefined) overrides.user_model = input.user_model;
      if (input.tools !== undefined) overrides.tools = input.tools;
      if (input.approvals !== undefined) overrides.approvals = input.approvals;
      if (input.allow_real_tools === true) overrides.allow_real_tools = true;
      if (input.repeats !== undefined) overrides.repeats = input.repeats;
      if (input.judge !== undefined) overrides.judge = input.judge;
      if (input.model !== undefined) overrides.model = input.model;
      if (input.max_cost_usd !== undefined) overrides.max_cost_usd = input.max_cost_usd;
      if (input.case_ids !== undefined) overrides.case_ids = input.case_ids;
      if (input.tags !== undefined) overrides.tags = input.tags;
      const callerId = callerIdFromRequestAuth();
      const startInput = {
        projectRoot,
        evalPath: ref.absPath,
        overrides,
        startedVia: "mcp" as const,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(callerId !== null ? { callerId } : {}),
      };
      try {
        await evalRunManager.preflightAgentStart(startInput);
      } catch (err) {
        audit("eval_run_start", "error", undefined, err instanceof EvalRunError ? err.code : "internal_error");
        throw err;
      }
      engineCheck((deps.evalEngineStatus ?? (() => promptfooEngineStatus({ home: globalStageflowHome() })))());
      let started;
      try {
        started = await evalRunManager.start(startInput);
      } catch (err) {
        audit("eval_run_start", "error", undefined, err instanceof EvalRunError ? err.code : "internal_error");
        throw err;
      }
      audit("eval_run_start", "ok", started.evalRunId);
      if (input.wait !== true) return { eval_run_id: started.evalRunId };
      const { finished, run } = await evalRunManager.awaitFinished(
        started.evalRunId,
        input.timeout_ms ?? DEFAULT_WAIT_MS,
      );
      if (!finished) return { eval_run_id: started.evalRunId, status: "timeout" };
      return runDetail(run);
    },
  );

  tool(
    "get_eval_run",
    "Get one eval run: status, progress, stats, cost, config snapshot and per-grader summary. Read-only, free. Same as GET /api/eval-runs/:id. Fails EVAL_RUN_NOT_FOUND for an unknown id.",
    z.object({ eval_run_id: z.string() }),
    async ({ eval_run_id }) => {
      manager();
      return runDetail(await runByIdOr404(store, eval_run_id));
    },
  );

  tool(
    "list_eval_runs",
    "List eval runs, newest first, as headlines (status, pass rate, cost). Filter by eval_id or status. Read-only, free. Same items as GET /api/eval-runs.",
    z.object({
      eval_id: z.string().optional(),
      status: z.enum(EVAL_RUN_STATUSES).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Default ${DEFAULT_LIMIT}`),
    }),
    async ({ eval_id, status, limit }) => {
      manager();
      const page = await listEvalRunsPage(store, {
        ...(eval_id !== undefined ? { evalId: eval_id } : {}),
        ...(status !== undefined ? { status } : {}),
        limit: limit ?? DEFAULT_LIMIT,
      });
      return { items: page.items };
    },
  );

  tool(
    "get_eval_results",
    "List the result rows (one per case) of an eval run with pass state, score and failing graders. Filter by status or grader; page with cursor. Read-only, free. Same as GET /api/eval-runs/:id/results.",
    z.object({
      eval_run_id: z.string(),
      status: z.string().optional().describe("Result row status filter, for example failed or passed"),
      grader: z.string().optional().describe("Only results this grader failed"),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Default ${DEFAULT_LIMIT}`),
      cursor: z.string().optional(),
    }),
    async ({ eval_run_id, status, grader, limit, cursor }) => {
      manager();
      const page = await buildResultsPage(store, eval_run_id, {
        ...(status !== undefined ? { status } : {}),
        ...(grader !== undefined ? { grader } : {}),
        limit: limit ?? DEFAULT_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return { items: page.items, next_cursor: page.next_cursor };
    },
  );

  tool(
    "get_eval_result",
    "Get one case of an eval run in full: the case input and expected value plus every repeat's stage output (for an agent eval, the conversation subject: messages, tool calls with policy outcomes, usage), grades, cost and review. Read-only, free. Same as GET /api/eval-runs/:id/results/:case_id.",
    z.object({ eval_run_id: z.string(), case_id: z.string() }),
    async ({ eval_run_id, case_id }) => {
      manager();
      return buildResultDetail(store, eval_run_id, case_id);
    },
  );

  const triage = (): TriageService =>
    new TriageService({
      store,
      judgeBackend: () => deps.agentConversationBackend,
      ...(deps.triage ?? {}),
    });

  tool(
    "sort_eval_failures",
    "Sort the failed and errored results of a finished eval run into suggested buckets (agent_wrong, grader_wrong, case_wrong, unclear) and failure types, each with a confidence. This sends each failed result's case, output and grader reasons to an external classifier: TypeSafe Jev (about $0.04 per million input tokens; needs a TypeSafe key) or the run's judge model (a model call per result, real cost). It is manual only and never runs on its own. Nothing is tagged: suggestions are reviewed and accepted by the author in the console or API. Eval sessions of the run stay hidden. classifier auto uses jev when a key exists, else judge, else fails EVAL_CLASSIFIER_UNAVAILABLE. By default results that already have a suggestion are skipped (only_unsorted). Fails EVAL_RUN_ACTIVE while the run is running. Same as POST /api/eval-runs/:id/failures/sort.",
    z.object({
      eval_run_id: z.string(),
      classifier: z.enum(["auto", "jev", "judge"]).optional().describe("Default auto"),
      only_unsorted: z.boolean().optional().describe("Skip results that already have a suggestion (default true)"),
      limit: z.number().int().min(1).max(TRIAGE_MAX_LIMIT).optional().describe("Most results to sort (default 200)"),
    }),
    async ({ eval_run_id, classifier, only_unsorted, limit }) => {
      manager();
      const row = await runByIdOr404(store, eval_run_id);
      try {
        const result = await triage().sort(row, {
          classifier: classifier ?? "auto",
          ...(only_unsorted !== undefined ? { onlyUnsorted: only_unsorted } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        audit("eval_failures_sort", "ok", eval_run_id);
        return result;
      } catch (err) {
        audit("eval_failures_sort", "error", eval_run_id, err instanceof EvalApiError ? err.code : "internal_error");
        throw err;
      }
    },
  );

  tool(
    "get_eval_failure_suggestions",
    "List the suggested buckets and failure types for an eval run's failed results, with a summary (counts by bucket, by failure type, by status, low confidence). Read-only, free, calls no model. Filter by status (pending, accepted, dismissed). Same as GET /api/eval-runs/:id/failures/suggestions.",
    z.object({ eval_run_id: z.string(), status: z.enum(SUGGESTION_STATUSES).optional() }),
    async ({ eval_run_id, status }) => {
      manager();
      return triage().list(await runByIdOr404(store, eval_run_id), status);
    },
  );

  tool(
    "get_eval_failure_sort_status",
    "Report which failure classifiers can run for an eval run: jev (needs a TypeSafe key; reports only the names of the sources that hold one, never the key) and judge (the run's judge model), and which one auto would use. Read-only, free. Same as GET /api/eval-runs/:id/failures/status.",
    z.object({ eval_run_id: z.string() }),
    async ({ eval_run_id }) => {
      manager();
      return triage().status(await runByIdOr404(store, eval_run_id));
    },
  );

  tool(
    "cancel_eval_run",
    "Cancel an eval run in progress and return its detail once it has stopped (waits up to 5 seconds). Stops spending; completed results are kept. A run that already finished is returned unchanged. Same as POST /api/eval-runs/:id/cancel.",
    z.object({ eval_run_id: z.string() }),
    async ({ eval_run_id }) => {
      const evalRunManager = manager();
      await runByIdOr404(store, eval_run_id);
      await evalRunManager.cancel(eval_run_id);
      const { run } = await evalRunManager.awaitFinished(eval_run_id, CANCEL_WAIT_MS);
      audit("eval_run_cancel", "ok", eval_run_id);
      return runDetail(run);
    },
  );

  tool(
    "compare_eval_runs",
    "Compare two eval runs of the same eval: per-grader and per-case differences, regressions and improvements, cost delta. a is the baseline, b the candidate. Read-only, free. Same as GET /api/eval-compare. Fails 400 when the runs are not comparable.",
    z.object({ a: z.string(), b: z.string() }),
    async ({ a, b }) => {
      manager();
      const left = await runByIdOr404(store, a);
      const right = await runByIdOr404(store, b);
      return buildCompare(store, left, right);
    },
  );
}
