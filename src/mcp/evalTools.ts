import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { EvalsWriteError, FileChangedError, contentHash } from "../config/atomicWrite.js";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveCatalogStartInput,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { formatId, nextIdNumber } from "../config/datasetImport.js";
import { casesFromRuns } from "../config/datasetCandidates.js";
import { casesFromSessions, SessionCaseError, type SessionsSource } from "../config/datasetFromSessions.js";
import { checkDatasetAgainstStage } from "../config/datasetStageCheck.js";
import type { DatasetCase } from "../config/datasetTypes.js";
import { listEvalFiles } from "../config/evalCatalog.js";
import {
  assertInsideProject,
  findEvalFile,
  manifestForWrite,
  resolveWriteDir,
} from "../config/evalWriteRoots.js";
import { EVAL_SAMPLE_FILES, installEvalSample, resolveEvalSampleDir, type EvalSampleAgents } from "../config/installEvalSample.js";
import { loadDatasetFile, parseDatasetText } from "../config/loadDataset.js";
import { loadEvalOutcome, resolveConversation, resolveEvalPaths } from "../config/loadEval.js";
import { resolveEvalTarget } from "../config/resolveEvalTarget.js";
import {
  appendOrReplaceCases,
  applyCaseOps,
  convertDatasetToJsonl,
  createDatasetFile,
  type CaseOp,
  type NewDatasetCase,
} from "../config/writeDataset.js";
import { createEvalFile, previewEvalUpdate, renderEvalCreateYaml, updateEvalFile } from "../config/writeEval.js";
import { CompareMismatchError } from "../evals/compare.js";
import { EVAL_LIMITS, EVAL_REVIEW_LABELS } from "../evals/constants.js";
import { engineStatus as promptfooEngineStatus } from "../evals/engine/promptfoo/status.js";
import { EvalRunError, type EvalRunManager, type TryCaseInput, type TryResult } from "../evals/manager.js";
import type { EvalOverrides } from "../evals/plan.js";
import {
  buildEvalDetail,
  buildResultDetail,
  buildResultsPage,
  DEFAULT_LIMIT,
  engineCheck,
  EvalApiError,
  locateDataset,
  locateEval,
  loadAggregatedEvalList,
  listEvalRunsPage,
  MAX_LIMIT,
  planFindings,
  runByIdOr404,
} from "../evals/read/api.js";
import { buildCompare } from "../evals/read/compare.js";
import {
  buildDatasetDetail,
  resolveDatasetTarget,
  type AgentDatasetUse,
  type DatasetTarget,
} from "../evals/read/datasets.js";
import { buildExport, buildRunDetail } from "../evals/read/runs.js";
import { EvalStoreError } from "../evals/storeError.js";
import { TRIAGE_MAX_LIMIT } from "../evals/triage/constants.js";
import { isTriageBucket, TriageService } from "../evals/triage/service.js";
import type { EvalFile } from "../evals/types.js";
import type { EvalRunRow } from "../evals/storeTypes.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { callerIdFromRequestAuth, getRequestAuth } from "../server/requestAuthContext.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import {
  getEvalFailuresFlatSchema,
  getEvalFlatSchema,
  getEvalResultsFlatSchema,
  getEvalRunFlatSchema,
  reviewEvalResultsFlatSchema,
  runEvalFlatSchema,
  saveDatasetFlatSchema,
  saveEvalFlatSchema,
  tryEvalCaseFlatSchema,
} from "../toolkit/evalToolModes.js";

const auditLog = rootLogger.child({ component: "audit" });

const CANCEL_WAIT_MS = 5000;
const DEFAULT_WAIT_MS = 600_000;
const MAX_WAIT_MS = 1_800_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CASE_OPS = new Set(["add", "update", "delete", "set_tags"]);

const projectRootField = z
  .string()
  .optional()
  .describe("Catalog project root; omit to use the host default");

const datasetCasesField = z
  .array(z.unknown())
  .optional()
  .describe("Inline cases used instead of the dataset file");

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

function bad(message: string): EvalApiError {
  return new EvalApiError(400, "invalid_request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withAssignedIds(cases: unknown[]): unknown[] {
  const hasId = (c: unknown): boolean => isRecord(c) && typeof c.id === "string" && c.id !== "";
  const existing = cases.filter(hasId).map((c) => (c as { id: string }).id);
  let next = nextIdNumber(existing);
  return cases.map((c) => (isRecord(c) && !hasId(c) ? { ...c, id: formatId(next++) } : c));
}

function optDatasetCases(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw bad(`"dataset_cases" must be an array`);
  return withAssignedIds(value);
}

function targetFrom(value: unknown): DatasetTarget {
  if (!isRecord(value)) throw bad(`"target" must be an object`);
  const target: DatasetTarget = {};
  for (const key of ["pipeline_path", "stage_id", "file", "agent_id"] as const) {
    const v = value[key];
    if (v !== undefined) {
      if (typeof v !== "string" || v === "") throw bad(`target.${key} must be a non-empty string`);
      target[key] = v;
    }
  }
  return target;
}

function tryCaseFrom(value: unknown): TryCaseInput {
  if (!isRecord(value) || !isRecord(value.input)) throw bad(`"case" must be an object with an input object`);
  return value as unknown as TryCaseInput;
}

function tryResultToWire(result: TryResult): { result: Record<string, unknown>; stage_run_id: string | null; cost_usd: number } {
  const r = result.result;
  return {
    result: {
      case_id: r.caseId,
      repeat_index: 0,
      status: r.status,
      error_code: r.errorCode,
      error_message: r.errorMessage,
      stage_run_id: r.stageRunId,
      subject_ref: null,
      turns: null,
      tool_call_count: null,
      output: r.output,
      latency_ms: r.latencyMs,
      cost_usd: r.costUsd,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      score: r.score,
      passed: r.passed,
      grades: r.grades.map((g) => ({
        grader_id: g.graderId,
        grader_type: g.graderType,
        status: g.status,
        passed: g.passed,
        score: g.score,
        raw_value: g.rawValue,
        reason: g.reason,
        details: g.details,
        error_code: g.errorCode,
        judge_model: null,
        judge_cost_usd: g.judgeCostUsd,
        judge_tokens_in: null,
        judge_tokens_out: null,
      })),
      budget_warnings: r.budgetWarnings,
      review: null,
      tags: [],
    },
    stage_run_id: result.stageRunId,
    cost_usd: result.costUsd,
  };
}

async function sampleCases(): Promise<DatasetCase[]> {
  const dir = resolveEvalSampleDir(undefined, EVAL_SAMPLE_FILES.dataset);
  if (dir === undefined) throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample files were not found");
  let text: string;
  try {
    text = await readFile(path.join(dir, EVAL_SAMPLE_FILES.dataset), "utf8");
  } catch {
    throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample dataset was not found");
  }
  return parseDatasetText(text, "jsonl").cases;
}

async function datasetDetailFor(projectRoot: string, id: string, absPath: string) {
  const loaded = await loadDatasetFile(absPath, { root: projectRoot });
  const manifest = await manifestForWrite(projectRoot);
  const refs = await listEvalFiles(manifest);
  const usedBy: string[] = [];
  let inputSchema: unknown;
  let agent: AgentDatasetUse | undefined;
  for (const ref of refs) {
    const outcome = await loadEvalOutcome(ref.absPath, projectRoot);
    if (!outcome.ok) continue;
    const { datasetPath } = resolveEvalPaths(outcome.value.file, outcome.value.path);
    if (path.resolve(datasetPath) !== path.resolve(absPath)) continue;
    usedBy.push(outcome.value.id);
    if (usedBy.length > 1) continue;
    if (outcome.value.file.target.kind === "agent") {
      agent = { mode: resolveConversation(outcome.value.file.conversation).mode };
    } else {
      const target = await resolveEvalTarget(outcome.value.file, outcome.value.path, projectRoot);
      if (target.ok) inputSchema = target.value.inputSchema;
    }
  }
  return buildDatasetDetail({
    id,
    loaded,
    inputSchema,
    ...(agent !== undefined ? { agent } : {}),
    hasEval: usedBy.length > 0,
    usedBy,
    query: { offset: 0, limit: MAX_LIMIT, filter: "all" },
  });
}

function errorResult(err: unknown) {
  if (err instanceof EvalApiError) {
    return textResult({ error: err.message, code: err.code, ...err.extra }, true);
  }
  if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
  if (err instanceof FileChangedError) {
    return textResult({ error: err.message, code: err.code, current_hash: err.currentHash }, true);
  }
  if (err instanceof EvalsWriteError) {
    return textResult(
      { error: err.message, code: err.code, ...(err.findings.length > 0 ? { findings: err.findings } : {}) },
      true,
    );
  }
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

  const roots = { store, bootCwd: cwd };

  const projectRootFor = async (wire: string | undefined): Promise<string> => {
    const { wireRoot } = await resolveCatalogStartInput(roots, wire);
    return wireRoot.path;
  };

  const writableRoot = async (wire: string | undefined): Promise<string> => {
    const { wireRoot } = await resolveWritableCatalogRoot(roots, wire);
    return wireRoot.path;
  };

  const agentsInput = () => (deps.agentService !== undefined ? { agents: deps.agentService } : {});

  const sampleAgents = (): EvalSampleAgents | undefined => {
    const agents = deps.agentService;
    if (agents?.create === undefined || agents.setEnabled === undefined) return undefined;
    return {
      get: (projectRoot, agentId) => agents.get(projectRoot, agentId),
      create: (projectRoot, raw, actor) => agents.create(projectRoot, raw, actor),
      setEnabled: (projectRoot, agentId, enabled, actor) => agents.setEnabled(projectRoot, agentId, enabled, actor),
    };
  };

  const sessionsOf = (): SessionsSource | undefined => deps.agentService;

  const requireEngine = (): void => {
    engineCheck((deps.evalEngineStatus ?? (() => promptfooEngineStatus({ home: globalStageflowHome() })))());
  };

  const runDetail = (row: EvalRunRow) =>
    buildRunDetail({ store, row, live: manager().getLive(row.evalRunId), ...agentsInput() });

  const schemaError = (message: string) => textResult({ error: message, code: "invalid_request" }, true);

  const tool = <S extends z.ZodType>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (input: z.infer<S>) => Promise<unknown>,
  ): void => {
    const run = async (raw: unknown) => {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      try {
        return textResult(await handler(parsed.data));
      } catch (err) {
        return errorResult(err);
      }
    };
    server.registerTool(name, { description, inputSchema }, run as never);
  };

  server.registerTool(
    "get_eval",
    {
      description:
        "List evals without eval_id; with eval_id and view definition get one eval; view calibrations lists grader calibration history for grader_id. Read-only, free.",
      inputSchema: getEvalFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (raw) => {
      const parsed = getEvalFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        manager();
        if (input.eval_id === undefined) {
          const { items } = await loadAggregatedEvalList({
            options: { store, bootCwd: cwd },
            wire: input.project_root,
            now: new Date(),
            ...agentsInput(),
          });
          return textResult({ items });
        }
        if ((input.view ?? "definition") === "calibrations") {
          const { projectRoot } = await locateEval({ store, bootCwd: cwd }, input.project_root, input.eval_id);
          const items = await store.listEvalCalibrations(
            projectRoot,
            input.eval_id,
            input.grader_id!,
            input.include_candidates === true,
          );
          return textResult({ items });
        }
        const { projectRoot, ref } = await locateEval({ store, bootCwd: cwd }, input.project_root, input.eval_id);
        return textResult(await buildEvalDetail({ store, projectRoot, absPath: ref.absPath, ...agentsInput() }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  tool(
    "run_eval",
    "Run an eval: every dataset case through its target (a stage, or an agent held as a conversation; repeats times each). This calls models and may cost real money (stage calls plus judge calls for rubric graders), bounded by max_cost_usd. Agent runs call the agent's model, a simulator model that plays the user, and the judge, and can cost much more than stage runs. Agent tools are read-only by default: write, shell, and unlisted tools are stubbed and recorded, never executed. conversation.tools: real also needs allow_real_tools true on top of allow_real_tools in the eval file, else EVAL_REAL_TOOLS_NOT_CONFIRMED. Stage evals skip signed-in console MCP unless allow_host_login is true; stdio servers and HTTP servers with Authorization still run. allow_host_login is the host-path consent; allow_real_tools is the consent to act on the project. One eval run per host; a second start fails EVAL_RUN_ACTIVE. wait false (default) returns { eval_run_id } (poll get_eval_run). wait true blocks up to timeout_ms (default 600000, max 1800000) and returns the run detail, or { eval_run_id, status: \"timeout\" } (the run keeps going; cancel_eval_run stops it). An invalid eval returns an error result with findings.",
    runEvalFlatSchema,
    async (input) => {
      const evalRunManager = manager();
      const { projectRoot, ref } = await locateEval(roots, input.project_root, input.eval_id);
      const overrides: EvalOverrides = {};
      if (input.user_model !== undefined) overrides.user_model = input.user_model;
      if (input.tools !== undefined) overrides.tools = input.tools;
      if (input.approvals !== undefined) overrides.approvals = input.approvals;
      if (input.allow_real_tools === true) overrides.allow_real_tools = true;
      if (input.allow_host_login === true) overrides.allow_host_login = true;
      if (input.repeats !== undefined) overrides.repeats = input.repeats;
      if (input.judge !== undefined) overrides.judge = input.judge;
      if (input.model !== undefined) overrides.model = input.model;
      if (input.max_cost_usd !== undefined) overrides.max_cost_usd = input.max_cost_usd;
      if (input.case_ids !== undefined) overrides.case_ids = input.case_ids;
      if (input.tags !== undefined) overrides.tags = input.tags;
      if (input.only_failed_from !== undefined) overrides.only_failed_from = input.only_failed_from;
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
      requireEngine();
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

  server.registerTool(
    "get_eval_run",
    {
      description:
        "List eval runs without eval_run_id; with eval_run_id get one run; view export returns run results or config snapshot. Read-only, free.",
      inputSchema: getEvalRunFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (raw) => {
      const parsed = getEvalRunFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        manager();
        if (input.eval_run_id === undefined) {
          const page = await listEvalRunsPage(store, {
            ...(input.eval_id !== undefined ? { evalId: input.eval_id } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            limit: input.limit ?? DEFAULT_LIMIT,
          });
          return textResult({ items: page.items });
        }
        const row = await runByIdOr404(store, input.eval_run_id);
        if (input.view === "export") {
          return textResult(await buildExport({ store, row, what: input.what ?? "results" }));
        }
        return textResult(await runDetail(row));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_eval_results",
    {
      description:
        "List result rows for an eval run, or set case_id for one case in full with every repeat. Read-only, free.",
      inputSchema: getEvalResultsFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (raw) => {
      const parsed = getEvalResultsFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        manager();
        if (input.case_id !== undefined) {
          return textResult(await buildResultDetail(store, input.eval_run_id, input.case_id));
        }
        const page = await buildResultsPage(store, input.eval_run_id, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.grader !== undefined ? { grader: input.grader } : {}),
          limit: input.limit ?? DEFAULT_LIMIT,
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        });
        return textResult({ items: page.items, next_cursor: page.next_cursor });
      } catch (err) {
        return errorResult(err);
      }
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
    "Sort failed and errored results into buckets (agent_wrong, grader_wrong, case_wrong, unclear) and failure types, each with a confidence. Sends case, output, and grader reasons to an external classifier: TypeSafe Jev (about $0.04 per million input tokens; needs a TypeSafe key) or the judge model (one call per result, real cost). Manual only. Nothing is tagged until reviewed and accepted by the author in the console or API. Eval sessions stay hidden. classifier auto: jev if a key exists, else judge, else EVAL_CLASSIFIER_UNAVAILABLE. only_unsorted (default) skips existing suggestions. Fails EVAL_RUN_ACTIVE while the run is running.",
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

  server.registerTool(
    "get_eval_failures",
    {
      description:
        "view suggestions lists failure suggestions for an eval run; view sort_status reports which classifiers can run (no key values). Read-only, free.",
      inputSchema: getEvalFailuresFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (raw) => {
      const parsed = getEvalFailuresFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        manager();
        const row = await runByIdOr404(store, input.eval_run_id);
        const view = input.view ?? "suggestions";
        if (view === "sort_status") return textResult(await triage().status(row));
        return textResult(await triage().list(row, input.status));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  tool(
    "calibrate_eval_grader",
    "Check a rubric or goal_reached judge against Pass/Fail labels. Re-judges stored outputs labeled for that grader (no stage or agent runs). Returns label count, agreement, Cohen's kappa, pass and fail recall, confusion counts, and disagreements. One judge call per label (three when stability is true). May cost real money, bounded by max_cost_usd (default 1). Sends outputs to the judge provider. split dev or held_out is a fixed 70/30 split. Fails EVAL_CALIBRATION_NO_LABELS when nothing is labeled and EVAL_RUN_ACTIVE while a run or try is active.",
    z.object({
      eval_id: z.string(),
      grader_id: z.string(),
      split: z.enum(["all", "dev", "held_out"]).optional().describe("Default all"),
      stability: z.boolean().optional().describe("Judge each label three times"),
      max_cost_usd: z.number().positive().optional().describe("Cost cap in USD (default 1)"),
      project_root: projectRootField,
    }),
    async (input) => {
      const evalRunManager = manager();
      const { projectRoot, ref } = await locateEval({ store, bootCwd: cwd }, input.project_root, input.eval_id);
      engineCheck((deps.evalEngineStatus ?? (() => promptfooEngineStatus({ home: globalStageflowHome() })))());
      try {
        const out = await evalRunManager.calibrate({
          projectRoot,
          evalPath: ref.absPath,
          graderId: input.grader_id,
          ...(input.split !== undefined ? { split: input.split } : {}),
          ...(input.stability === true ? { stability: true } : {}),
          ...(input.max_cost_usd !== undefined ? { maxCostUsd: input.max_cost_usd } : {}),
        });
        audit("eval_calibrate", "ok");
        return out.calibration;
      } catch (err) {
        audit("eval_calibrate", "error", undefined, err instanceof EvalRunError ? err.code : "internal_error");
        throw err;
      }
    },
  );

  tool(
    "cancel_eval_run",
    "Cancel an eval run in progress and return its detail once it has stopped (waits up to 5 seconds). A run that already finished is returned unchanged.",
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
    "Compare two eval runs of the same eval. a is the baseline, b the candidate. Read-only, free. Fails 400 when the runs are not comparable.",
    z.object({ a: z.string(), b: z.string() }),
    async ({ a, b }) => {
      manager();
      const left = await runByIdOr404(store, a);
      const right = await runByIdOr404(store, b);
      return buildCompare(store, left, right);
    },
  );

  const evalDetail = (projectRoot: string, absPath: string) =>
    buildEvalDetail({ store, projectRoot, absPath, ...agentsInput() });

  server.registerTool(
    "save_eval",
    {
      description:
        "mode create writes a new eval from definition, or source sample installs the packaged sample. mode update replaces an eval with definition or yaml and base_hash.",
      inputSchema: saveEvalFlatSchema,
    },
    async (raw) => {
      const parsed = saveEvalFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        if (input.mode === "create" && input.source === "sample") {
          const projectRoot = await writableRoot(input.project_root);
          const port = sampleAgents();
          const result = await installEvalSample({
            projectRoot,
            ...(input.kind === "agent" ? { kind: input.kind } : {}),
            ...(port ? { agents: port } : {}),
          });
          audit("eval_sample_install", "ok");
          return textResult({ eval_id: result.evalId });
        }
        if (input.mode === "create") {
          const file = input.definition! as unknown as EvalFile;
          const projectRoot = await writableRoot(input.project_root);
          const manifest = await manifestForWrite(projectRoot);
          const dir = await resolveWriteDir(projectRoot, manifest, "evals", input.directory);
          const rawId = (file as { id?: unknown }).id;
          const fileName = typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml";
          const absPath = path.join(dir.absDir, fileName);
          assertInsideProject(projectRoot, absPath, "eval path");
          if (typeof rawId === "string" && (await findEvalFile(projectRoot, rawId, manifest)) !== undefined) {
            throw new EvalsWriteError("EVAL_EXISTS", `Eval "${rawId}" already exists`);
          }
          const text = renderEvalCreateYaml(file);
          const checked = await planFindings({ projectRoot, evalPath: absPath, evalText: text, ...agentsInput() });
          if (!checked.ok) {
            audit("eval_create", "error", undefined, "EVAL_INVALID");
            throw new EvalApiError(422, "EVAL_INVALID", "Eval definition is invalid", { findings: checked.findings });
          }
          const written = await createEvalFile({
            projectRoot,
            definition: file,
            ...(input.directory !== undefined ? { directory: input.directory } : {}),
          });
          audit("eval_create", "ok");
          return textResult(await evalDetail(projectRoot, written.path));
        }
        const { eval_id, base_hash, definition, yaml } = input;
        const { projectRoot, ref } = await locateEval(roots, input.project_root, eval_id!, true);
        const current = await readFile(ref.absPath);
        const currentHash = contentHash(current);
        if (currentHash !== base_hash) throw new FileChangedError(currentHash);
        const text =
          yaml !== undefined
            ? yaml.endsWith("\n")
              ? yaml
              : `${yaml}\n`
            : previewEvalUpdate(current.toString("utf8"), definition!);
        const checked = await planFindings({ projectRoot, evalPath: ref.absPath, evalText: text, ...agentsInput() });
        if (!checked.ok) {
          audit("eval_update", "error", undefined, "EVAL_INVALID");
          throw new EvalApiError(422, "EVAL_INVALID", "Eval definition is invalid", { findings: checked.findings });
        }
        await updateEvalFile({
          projectRoot,
          id: eval_id!,
          baseHash: base_hash!,
          ...(yaml !== undefined ? { yaml } : { definition: definition! }),
        });
        audit("eval_update", "ok");
        return textResult(await evalDetail(projectRoot, ref.absPath));
      } catch (err) {
        if (err instanceof EvalsWriteError && input.mode === "create" && input.source === "sample") {
          audit("eval_sample_install", "error", undefined, err.code);
        }
        return errorResult(err);
      }
    },
  );

  const casesFromRunsInput = async (
    projectRoot: string,
    target: unknown,
    runIds: string[] | undefined,
  ): Promise<NewDatasetCase[]> => {
    const resolved = await resolveDatasetTarget(projectRoot, targetFrom(target));
    if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
    if (runIds === undefined || runIds.length === 0) throw bad(`"run_ids" must be a non-empty array`);
    if (resolved.value.stageId === undefined) throw bad("target does not name a stage");
    return casesFromRuns({
      store,
      runIds,
      target: {
        stageId: resolved.value.stageId,
        ...(resolved.value.pipelineAbsPath !== undefined ? { pipelinePath: resolved.value.pipelineAbsPath } : {}),
      },
    });
  };

  const casesFromSessionsInput = async (
    projectRoot: string,
    target: unknown,
    sessionIds: string[] | undefined,
  ): Promise<NewDatasetCase[]> => {
    const resolved = await resolveDatasetTarget(projectRoot, targetFrom(target), deps.agentService);
    if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
    if (resolved.value.agentId === undefined) throw bad(`source "sessions" needs target.agent_id`);
    if (sessionIds === undefined || sessionIds.length === 0) throw bad(`"session_ids" must be a non-empty array`);
    const sessions = sessionsOf();
    if (sessions === undefined) throw new EvalApiError(503, "EVAL_ENGINE_UNAVAILABLE", "Agents are not available on this Host");
    try {
      return await casesFromSessions({ sessions, projectRoot, agentId: resolved.value.agentId, sessionIds });
    } catch (err) {
      if (err instanceof SessionCaseError) throw bad(err.message);
      throw err;
    }
  };

  server.registerTool(
    "save_dataset",
    {
      description:
        "mode create writes a new dataset (cases or source sample, runs, sessions). mode update with action append, replace, ops, or convert edits an existing dataset.",
      inputSchema: saveDatasetFlatSchema,
    },
    async (raw) => {
      const parsed = saveDatasetFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        if (input.mode === "update" && input.action === "convert") {
          const { projectRoot } = await locateDataset(roots, input.project_root, input.dataset_id!, {
            write: true,
            missing: "default",
          });
          const written = await convertDatasetToJsonl({
            projectRoot,
            id: input.dataset_id!,
            baseHash: input.base_hash!,
          });
          audit("dataset_write", "ok");
          return textResult(await datasetDetailFor(projectRoot, written.id, written.path));
        }
        if (input.mode === "update" && input.action === "ops") {
          const ops = input.ops!;
          if (ops.some((op) => !CASE_OPS.has(String(op.op)))) {
            throw bad(`"ops" must be an array of add, update, delete or set_tags operations`);
          }
          const { projectRoot } = await locateDataset(roots, input.project_root, input.dataset_id!, {
            write: true,
            missing: "default",
          });
          const written = await applyCaseOps({
            projectRoot,
            id: input.dataset_id!,
            baseHash: input.base_hash!,
            ops: ops as CaseOp[],
          });
          audit("dataset_write", "ok");
          return textResult(await datasetDetailFor(projectRoot, input.dataset_id!, written.path));
        }
        const projectRoot =
          input.mode === "update"
            ? (await locateDataset(roots, input.project_root, input.dataset_id!, { write: true, missing: "default" }))
                .projectRoot
            : await writableRoot(input.project_root);
        let absPath: string;
        let id: string;
        if (input.mode === "update") {
          id = input.dataset_id!;
          const appendMode = input.action as "append" | "replace";
          let newCases: NewDatasetCase[];
          if (input.source === "runs") {
            newCases = await casesFromRunsInput(projectRoot, input.target, input.run_ids);
          } else if (input.source === "sessions") {
            newCases = await casesFromSessionsInput(projectRoot, input.target, input.session_ids);
          } else {
            newCases = input.cases! as NewDatasetCase[];
          }
          const written = await appendOrReplaceCases({
            projectRoot,
            id,
            baseHash: input.base_hash!,
            mode: appendMode,
            cases: newCases,
          });
          absPath = written.path;
        } else {
          id = input.name!;
          let cases: NewDatasetCase[];
          if (input.source === "sessions") {
            cases = await casesFromSessionsInput(projectRoot, input.target, input.session_ids);
          } else if (input.source === "sample" || input.source === "runs") {
            const resolved = await resolveDatasetTarget(projectRoot, targetFrom(input.target), deps.agentService);
            if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
            if (resolved.value.agentId !== undefined) {
              throw bad(`source "${input.source}" is not available for an agent target`);
            }
            if (input.source === "sample") {
              const sample = await sampleCases();
              const failing = checkDatasetAgainstStage(sample, resolved.value.inputSchema).find((row) => !row.valid);
              if (failing) throw new EvalsWriteError("DATASET_INVALID", "The sample cases do not match this stage's input");
              cases = sample;
            } else {
              cases = await casesFromRunsInput(projectRoot, input.target, input.run_ids);
            }
          } else {
            cases = input.cases! as NewDatasetCase[];
          }
          const written = await createDatasetFile({
            projectRoot,
            name: id,
            cases,
            ...(input.directory !== undefined ? { directory: input.directory } : {}),
          });
          absPath = written.path;
        }
        audit("dataset_write", "ok");
        return textResult(await datasetDetailFor(projectRoot, id, absPath));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  tool(
    "try_eval_case",
    "Run one case and return its grade. Exactly one of eval_id or definition, and exactly one of case_id or case. dataset_cases replace the dataset file. Calls the target model once and may cost real money, bounded by max_cost_usd; judge graders call the judge too. A simulator plays the user for an agent case. Agent tools stay read-only unless conversation.tools is real and allow_real_tools is true. Stage tries skip signed-in console MCP unless allow_host_login is true; stdio servers and HTTP servers with a resolved Authorization header still run. Nothing is saved, and no eval session is returned.",
    tryEvalCaseFlatSchema,
    async (input) => {
      const { eval_id, definition, case_id, case: caseInput, dataset_cases, allow_real_tools, allow_host_login, project_root } =
        input;
      const evalRunManager = manager();
      const datasetCases = optDatasetCases(dataset_cases);
      const located = eval_id !== undefined ? await locateEval(roots, project_root, eval_id) : undefined;
      const projectRoot = located?.projectRoot ?? (await projectRootFor(project_root));
      const manifest = await manifestForWrite(projectRoot);
      let evalPath: string;
      let file: EvalFile | undefined;
      if (located !== undefined) {
        evalPath = located.ref.absPath;
      } else {
        file = definition as unknown as EvalFile;
        const rawId = (file as { id?: unknown }).id;
        const dir = await resolveWriteDir(projectRoot, manifest, "evals");
        evalPath = path.join(dir.absDir, typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml");
        assertInsideProject(projectRoot, evalPath, "eval path");
      }
      requireEngine();
      const tried = await evalRunManager.tryOne({
        projectRoot,
        evalPath,
        ...(file !== undefined ? { definition: file } : {}),
        ...(datasetCases !== undefined ? { datasetCases } : {}),
        ...(case_id !== undefined ? { caseId: case_id } : { case: tryCaseFrom(caseInput) }),
        ...(allow_real_tools === true ? { allowRealTools: true } : {}),
        ...(allow_host_login === true ? { allowHostLogin: true } : {}),
      });
      audit("eval_try", "ok");
      return tryResultToWire(tried);
    },
  );

  server.registerTool(
    "review_eval_results",
    {
      description:
        "action label sets pass, fail, note, or tags on one repeat; action accept writes tags from suggestions; action dismiss dismisses suggestions.",
      inputSchema: reviewEvalResultsFlatSchema,
    },
    async (raw) => {
      const parsed = reviewEvalResultsFlatSchema.safeParse(raw);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const input = parsed.data;
      try {
        manager();
        const row = await runByIdOr404(store, input.eval_run_id);
        if (input.action === "accept") {
          const result = await triage().accept(row, {
            ...(input.ids !== undefined ? { ids: input.ids } : {}),
            ...(input.min_confidence !== undefined ? { minConfidence: input.min_confidence } : {}),
            ...(isTriageBucket(input.bucket) ? { bucket: input.bucket } : {}),
          });
          audit("eval_suggestions_accept", "ok", input.eval_run_id);
          return textResult(result);
        }
        if (input.action === "dismiss") {
          const result = await triage().dismiss(row, input.ids!);
          audit("eval_suggestions_dismiss", "ok", input.eval_run_id);
          return textResult(result);
        }
        const patch: { label?: "pass" | "fail"; note?: string | null; tags?: string[] } = {};
        if (input.label !== undefined) {
          if (!(EVAL_REVIEW_LABELS as readonly string[]).includes(input.label)) throw bad(`"label" must be pass or fail`);
          patch.label = input.label as "pass" | "fail";
        }
        if (input.note !== undefined) {
          if (input.note !== null && input.note.length > EVAL_LIMITS.reviewNoteMaxChars) {
            throw bad(`"note" must be a string of at most ${EVAL_LIMITS.reviewNoteMaxChars} characters or null`);
          }
          patch.note = input.note;
        }
        if (input.tags !== undefined) {
          if (input.tags.some((t) => t.length > EVAL_LIMITS.failureTypeNameMaxChars)) {
            throw bad(`Each tag must be at most ${EVAL_LIMITS.failureTypeNameMaxChars} characters`);
          }
          patch.tags = input.tags;
        }
        const review = await store.putEvalReview(input.eval_run_id, input.case_id!, input.repeat_index!, patch);
        audit("eval_review", "ok", input.eval_run_id);
        return textResult({ label: review.label, note: review.note, tags: review.tags });
      } catch (err) {
        if (err instanceof EvalStoreError) return errorResult(err);
        return errorResult(err);
      }
    },
  );

  tool(
    "delete_eval_run",
    "Delete a finished eval run, its results, and the stage runs it recorded. A queued or running run fails EVAL_RUN_ACTIVE; cancel it first. Agent eval sessions for the run are deleted with it and are not listed anywhere else.",
    z.object({ eval_run_id: z.string() }),
    async ({ eval_run_id }) => {
      manager();
      const row = await runByIdOr404(store, eval_run_id);
      if (row.status === "queued" || row.status === "running") {
        throw new EvalApiError(409, "EVAL_RUN_ACTIVE", "Eval run is still running; cancel it first");
      }
      const sessionIds = row.targetKind === "agent" ? await store.listEvalSubjectRefs(eval_run_id, "agent") : [];
      const stageRunIds = await store.deleteEvalRun(eval_run_id);
      for (const runId of stageRunIds) {
        await deps.manager.deleteRun(runId, { channel: "rest" }).catch(() => undefined);
      }
      if (sessionIds.length > 0) {
        await deps.agentService?.deleteEvalSessions(row.projectRoot, sessionIds).catch(() => undefined);
      }
      audit("eval_run_delete", "ok", eval_run_id);
      return { deleted: true };
    },
  );
}
