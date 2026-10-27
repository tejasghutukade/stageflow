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
import { EVAL_SAMPLE_FILES, installEvalSample, type EvalSampleAgents } from "../config/installEvalSample.js";
import { loadDatasetFile, parseDatasetText } from "../config/loadDataset.js";
import { loadEvalOutcome, resolveConversation, resolveEvalPaths } from "../config/loadEval.js";
import { resolveEvalTarget } from "../config/resolveEvalTarget.js";
import { resolveSeededExamplesPath } from "../config/seededCatalog.js";
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
import { EVAL_LIMITS, EVAL_REVIEW_LABELS, EVAL_RUN_STATUSES } from "../evals/constants.js";
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
  validateEvalText,
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
import { SUGGESTION_STATUSES, TRIAGE_BUCKETS, TRIAGE_MAX_LIMIT } from "../evals/triage/constants.js";
import { isTriageBucket, TriageService } from "../evals/triage/service.js";
import type { EvalFile } from "../evals/types.js";
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
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CASE_OPS = new Set(["add", "update", "delete", "set_tags"]);

const datasetTargetObject = z
  .object({
    pipeline_path: z.string().optional(),
    stage_id: z.string().optional(),
    file: z.string().optional(),
    agent_id: z.string().optional(),
  })
  .describe("Stage (pipeline_path + stage_id, or file) or agent_id the imported cases must match");

const datasetTargetField = datasetTargetObject.optional();

const projectRootField = z
  .string()
  .optional()
  .describe("Catalog project root; omit to use the host default");

const evalPathField = z
  .string()
  .optional()
  .describe("Eval path relative to the project, used to resolve dataset and target paths");

const datasetCasesField = z
  .array(z.unknown())
  .optional()
  .describe("Inline cases used instead of the dataset file");

const validateEvalSchema = z.union([
  z.strictObject({
    eval_id: z.string(),
    path: evalPathField,
    dataset_cases: datasetCasesField,
    project_root: projectRootField,
  }),
  z.strictObject({
    yaml: z.string(),
    path: evalPathField,
    dataset_cases: datasetCasesField,
    project_root: projectRootField,
  }),
]);

const definitionField = z.record(z.string(), z.unknown());

const updateEvalSchema = z.union([
  z.strictObject({
    eval_id: z.string(),
    base_hash: z.string().min(1),
    definition: definitionField,
    project_root: projectRootField,
  }),
  z.strictObject({
    eval_id: z.string(),
    base_hash: z.string().min(1),
    yaml: z.string(),
    project_root: projectRootField,
  }),
]);

const caseRecord = z.record(z.string(), z.unknown());
const caseOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), case: caseRecord }),
  z.strictObject({ op: z.literal("update"), id: z.string(), case: caseRecord }),
  z.strictObject({ op: z.literal("delete"), id: z.string() }),
  z.strictObject({ op: z.literal("set_tags"), id: z.string(), tags: z.array(z.string()) }),
]);

const datasetDirectoryField = z
  .string()
  .optional()
  .describe("Catalog directory for a new dataset, relative to the project");

const datasetCreateShared = {
  directory: datasetDirectoryField,
  project_root: projectRootField,
};

const createDatasetSchema = z.union([
  z.strictObject({
    dataset_id: z.string().min(1),
    mode: z.literal("append"),
    base_hash: z.string().min(1),
    source: z.literal("runs"),
    target: datasetTargetObject,
    run_ids: z.array(z.string()).min(1),
    project_root: projectRootField,
  }),
  z.strictObject({
    dataset_id: z.string().min(1),
    mode: z.literal("append"),
    base_hash: z.string().min(1),
    source: z.literal("sessions"),
    target: datasetTargetObject,
    session_ids: z.array(z.string()).min(1),
    project_root: projectRootField,
  }),
  z.strictObject({
    dataset_id: z.string().min(1),
    mode: z.enum(["append", "replace"]),
    base_hash: z.string().min(1),
    cases: z.array(caseRecord),
    project_root: projectRootField,
  }),
  z.strictObject({
    name: z.string().min(1),
    source: z.literal("sample"),
    target: datasetTargetObject,
    ...datasetCreateShared,
  }),
  z.strictObject({
    name: z.string().min(1),
    source: z.literal("runs"),
    target: datasetTargetObject,
    run_ids: z.array(z.string()).min(1),
    ...datasetCreateShared,
  }),
  z.strictObject({
    name: z.string().min(1),
    source: z.literal("sessions"),
    target: datasetTargetObject,
    session_ids: z.array(z.string()).min(1),
    ...datasetCreateShared,
  }),
  z.strictObject({
    name: z.string().min(1),
    cases: z.array(caseRecord),
    target: datasetTargetField,
    ...datasetCreateShared,
  }),
]);

const tryShared = {
  dataset_cases: datasetCasesField,
  allow_real_tools: z.boolean().optional().describe("Agent evals: consent to conversation.tools real; no effect on other policies"),
  project_root: projectRootField,
};

const tryCaseField = caseRecord.describe("Inline case; must include an input object");

const tryEvalCaseSchema = z.union([
  z.strictObject({ eval_id: z.string(), case_id: z.string(), ...tryShared }),
  z.strictObject({ eval_id: z.string(), case: tryCaseField, ...tryShared }),
  z.strictObject({ definition: definitionField, case_id: z.string(), ...tryShared }),
  z.strictObject({ definition: definitionField, case: tryCaseField, ...tryShared }),
]);

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
  const examples = resolveSeededExamplesPath();
  const dir = examples === undefined ? undefined : path.join(examples, "evals");
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

  const tool = <S extends z.ZodType>(
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
    "Validate an eval without running it: pass eval_id for a file in the catalog, or yaml for unsaved text (exactly one). Optional path is the file location used to resolve relative paths (required only to check an unsaved eval against a specific path). Optional dataset_cases stand in for the dataset file, the same as POST /api/evals/validate. Checks schema, target, dataset and graders and returns { findings }. Read-only, free, calls no model; writes no files.",
    validateEvalSchema,
    async (input) => {
      const { eval_id, yaml, path: evalPath, dataset_cases, project_root } = input as typeof input & {
        eval_id?: string;
        yaml?: string;
        path?: string;
      };
      manager();
      if ((eval_id === undefined) === (yaml === undefined)) {
        throw new EvalApiError(400, "invalid_request", "Provide exactly one of eval_id or yaml");
      }
      const datasetCases = optDatasetCases(dataset_cases);
      const located = eval_id !== undefined ? await locateEval(roots, project_root, eval_id) : undefined;
      const projectRoot = located?.projectRoot ?? (await projectRootFor(project_root));
      let evalAbs: string;
      if (evalPath !== undefined) {
        evalAbs = path.resolve(projectRoot, evalPath);
        assertInsideProject(projectRoot, evalAbs, "eval path");
      } else if (located !== undefined) {
        evalAbs = located.ref.absPath;
      } else {
        const manifest = await manifestForWrite(projectRoot);
        const dir = await resolveWriteDir(projectRoot, manifest, "evals");
        const rawId = /^id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,63})["']?\s*$/m.exec(yaml as string)?.[1];
        evalAbs = path.join(dir.absDir, `${rawId ?? "new"}.eval.yaml`);
        assertInsideProject(projectRoot, evalAbs, "eval path");
      }
      const derived =
        yaml !== undefined
          ? yaml.endsWith("\n")
            ? yaml
            : `${yaml}\n`
          : await readFile(located!.ref.absPath, "utf8");
      const { findings } = await validateEvalText({
        projectRoot,
        evalAbs,
        derived,
        ...(datasetCases !== undefined ? { datasetCases } : {}),
        ...agentsInput(),
      });
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
      only_failed_from: z.string().optional().describe("Run only cases that failed in this earlier eval run of the same eval"),
      label: z.string().max(EVAL_LIMITS.labelMaxChars).optional().describe("Free-text label for the run"),
      wait: z.boolean().optional().describe("Block until finished (default false)"),
      timeout_ms: z.number().int().min(1).max(MAX_WAIT_MS).optional().describe(`Wait budget in ms when wait is true (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS})`),
      project_root: projectRootField,
    }),
    async (input) => {
      const evalRunManager = manager();
      const { projectRoot, ref } = await locateEval(roots, input.project_root, input.eval_id);
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

  const evalDetail = (projectRoot: string, absPath: string) =>
    buildEvalDetail({ store, projectRoot, absPath, ...agentsInput() });

  tool(
    "create_eval",
    "Create an eval file from a definition object. Validates the full plan first (target, dataset, graders) and writes only when that passes. Same as POST /api/evals. Fails EVAL_EXISTS when the id is already in the catalog, EVAL_INVALID with findings when the definition is not runnable. Does not call a model.",
    z.object({
      definition: z.record(z.string(), z.unknown()).describe("Eval definition object, the same shape as an eval file"),
      directory: z.string().optional().describe("Catalog directory to write into, relative to the project"),
      project_root: projectRootField,
    }),
    async ({ definition, directory, project_root }) => {
      const file = definition as unknown as EvalFile;
      const projectRoot = await writableRoot(project_root);
      const manifest = await manifestForWrite(projectRoot);
      const dir = await resolveWriteDir(projectRoot, manifest, "evals", directory);
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
      const written = await createEvalFile({ projectRoot, definition: file, ...(directory !== undefined ? { directory } : {}) });
      audit("eval_create", "ok");
      return evalDetail(projectRoot, written.path);
    },
  );

  tool(
    "update_eval",
    "Replace an eval file. Pass exactly one of definition (merged into the current file) or yaml (the full file text), plus base_hash from get_eval. Refuses with FILE_CHANGED and current_hash when the file moved, and EVAL_INVALID with findings when the result is not runnable. Same as PUT /api/evals/:id. Does not call a model.",
    updateEvalSchema,
    async (input) => {
      const { eval_id, base_hash, definition, yaml, project_root } = input as typeof input & {
        definition?: Record<string, unknown>;
        yaml?: string;
      };
      if ((definition === undefined) === (yaml === undefined)) throw bad("Provide exactly one of definition or yaml");
      if (base_hash === "") throw bad(`"base_hash" is required`);
      const { projectRoot, ref } = await locateEval(roots, project_root, eval_id, true);
      const current = await readFile(ref.absPath);
      const currentHash = contentHash(current);
      if (currentHash !== base_hash) throw new FileChangedError(currentHash);
      const text =
        yaml !== undefined ? (yaml.endsWith("\n") ? yaml : `${yaml}\n`) : previewEvalUpdate(current.toString("utf8"), definition);
      const checked = await planFindings({ projectRoot, evalPath: ref.absPath, evalText: text, ...agentsInput() });
      if (!checked.ok) {
        audit("eval_update", "error", undefined, "EVAL_INVALID");
        throw new EvalApiError(422, "EVAL_INVALID", "Eval definition is invalid", { findings: checked.findings });
      }
      await updateEvalFile({
        projectRoot,
        id: eval_id,
        baseHash: base_hash,
        ...(yaml !== undefined ? { yaml } : { definition }),
      });
      audit("eval_update", "ok");
      return evalDetail(projectRoot, ref.absPath);
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

  tool(
    "create_dataset",
    "Create a dataset, or append or replace cases in one. Pass name and cases for a new file. source sample copies the packaged sample cases (they must match target). source runs copies recorded stage inputs (run_ids, append only when updating). source sessions copies finished agent sessions (session_ids and target.agent_id, append only when updating; needs the agent service). To update an existing file pass dataset_id, mode append or replace, and base_hash. Same as POST /api/datasets. Does not call a model.",
    createDatasetSchema,
    async (raw) => {
      const input = raw as {
        name?: string;
        cases?: Record<string, unknown>[];
        source?: "sample" | "runs" | "sessions";
        target?: z.infer<typeof datasetTargetObject>;
        run_ids?: string[];
        session_ids?: string[];
        dataset_id?: string;
        mode?: "append" | "replace";
        base_hash?: string;
        directory?: string;
        project_root?: string;
      };
      const datasetId = input.dataset_id !== undefined && input.dataset_id !== "" ? input.dataset_id : undefined;
      const projectRoot =
        datasetId !== undefined
          ? (await locateDataset(roots, input.project_root, datasetId, { write: true, missing: "default" })).projectRoot
          : await writableRoot(input.project_root);
      let absPath: string;
      let id: string;
      if (datasetId !== undefined) {
        id = datasetId;
        if (input.mode !== "append" && input.mode !== "replace") throw bad(`"mode" must be append or replace`);
        if (typeof input.base_hash !== "string" || input.base_hash === "") throw bad(`"base_hash" is required`);
        let newCases: NewDatasetCase[];
        if (input.source === "runs") {
          if (input.mode !== "append") throw bad(`source "runs" requires mode "append"`);
          newCases = await casesFromRunsInput(projectRoot, input.target, input.run_ids);
        } else if (input.source === "sessions") {
          if (input.mode !== "append") throw bad(`source "sessions" requires mode "append"`);
          newCases = await casesFromSessionsInput(projectRoot, input.target, input.session_ids);
        } else {
          if (!Array.isArray(input.cases)) throw bad(`"cases" must be an array`);
          newCases = input.cases as NewDatasetCase[];
        }
        const written = await appendOrReplaceCases({
          projectRoot,
          id,
          baseHash: input.base_hash,
          mode: input.mode,
          cases: newCases,
        });
        absPath = written.path;
      } else {
        const name = input.name;
        if (name === undefined || name === "") throw bad(`"name" is required`);
        id = name;
        let cases: NewDatasetCase[];
        if (input.source === "sessions") {
          cases = await casesFromSessionsInput(projectRoot, input.target, input.session_ids);
        } else if (input.source === "sample" || input.source === "runs") {
          const resolved = await resolveDatasetTarget(projectRoot, targetFrom(input.target), deps.agentService);
          if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
          if (resolved.value.agentId !== undefined) throw bad(`source "${input.source}" is not available for an agent target`);
          if (input.source === "sample") {
            const sample = await sampleCases();
            const failing = checkDatasetAgainstStage(sample, resolved.value.inputSchema).find((row) => !row.valid);
            if (failing) throw new EvalsWriteError("DATASET_INVALID", "The sample cases do not match this stage's input");
            cases = sample;
          } else {
            cases = await casesFromRunsInput(projectRoot, input.target, input.run_ids);
          }
        } else {
          if (!Array.isArray(input.cases)) throw bad(`"cases" must be an array`);
          cases = input.cases as NewDatasetCase[];
        }
        const written = await createDatasetFile({
          projectRoot,
          name,
          cases,
          ...(input.directory !== undefined ? { directory: input.directory } : {}),
        });
        absPath = written.path;
      }
      audit("dataset_write", "ok");
      return datasetDetailFor(projectRoot, id, absPath);
    },
  );

  tool(
    "update_dataset_cases",
    "Apply add, update, delete, and set_tags operations to a .dataset.jsonl file. base_hash must be the current file hash. The whole list is one write: a bad op changes nothing. Same as PATCH /api/datasets/:id/cases. Fails DATASET_READ_ONLY for json or csv (convert_dataset first). Does not call a model.",
    z.object({
      dataset_id: z.string(),
      base_hash: z.string().min(1),
      ops: z.array(caseOpSchema),
      project_root: projectRootField,
    }),
    async ({ dataset_id, base_hash, ops, project_root }) => {
      if (base_hash === "") throw bad(`"base_hash" is required`);
      if (ops.some((op) => !CASE_OPS.has(String(op.op)))) {
        throw bad(`"ops" must be an array of add, update, delete or set_tags operations`);
      }
      const { projectRoot } = await locateDataset(roots, project_root, dataset_id, { write: true, missing: "default" });
      const written = await applyCaseOps({ projectRoot, id: dataset_id, baseHash: base_hash, ops: ops as CaseOp[] });
      audit("dataset_write", "ok");
      return datasetDetailFor(projectRoot, dataset_id, written.path);
    },
  );

  tool(
    "convert_dataset",
    "Copy a .dataset.json or .dataset.csv file to an editable .dataset.jsonl sibling and return that file. The original is left in place. base_hash is the current source hash. Same as POST /api/datasets/:id/convert. Does not call a model.",
    z.object({
      dataset_id: z.string(),
      base_hash: z.string(),
      project_root: projectRootField,
    }),
    async ({ dataset_id, base_hash, project_root }) => {
      if (base_hash === "") throw bad(`"base_hash" is required`);
      const { projectRoot } = await locateDataset(roots, project_root, dataset_id, { write: true, missing: "default" });
      const written = await convertDatasetToJsonl({ projectRoot, id: dataset_id, baseHash: base_hash });
      audit("dataset_write", "ok");
      return datasetDetailFor(projectRoot, written.id, written.path);
    },
  );

  tool(
    "install_eval_sample",
    "Install the packaged sample eval into the project. kind stage (default) writes the critique sample pipeline, dataset, and eval. kind agent writes the support sample and creates its agent; without the agent service it fails SAMPLE_AGENTS_UNAVAILABLE. Same as POST /api/evals/sample. Fails SAMPLE_EXISTS when that sample is already installed. Does not call a model.",
    z.object({
      kind: z.enum(["stage", "agent"]).optional().describe('Default "stage"'),
      project_root: projectRootField,
    }),
    async ({ kind, project_root }) => {
      const projectRoot = await writableRoot(project_root);
      try {
        const port = sampleAgents();
        const result = await installEvalSample({
          projectRoot,
          ...(kind === "agent" ? { kind } : {}),
          ...(port ? { agents: port } : {}),
        });
        audit("eval_sample_install", "ok");
        return { eval_id: result.evalId };
      } catch (err) {
        if (err instanceof EvalsWriteError) audit("eval_sample_install", "error", undefined, err.code);
        throw err;
      }
    },
  );

  tool(
    "try_eval_case",
    "Run one case of an eval and return its grade. Pass exactly one of eval_id or definition, and exactly one of case_id or case. dataset_cases stand in for the dataset file. This calls the target model once and may cost real money, bounded by the eval's max_cost_usd; graders that need a judge call the judge too. Agent tools stay read-only unless the eval file sets conversation.tools real and allow_real_tools is true. Nothing is saved as an eval run, and no eval session is returned. Same as POST /api/evals/try.",
    tryEvalCaseSchema,
    async (input) => {
      const { eval_id, definition, case_id, case: caseInput, dataset_cases, allow_real_tools, project_root } =
        input as typeof input & {
          eval_id?: string;
          definition?: Record<string, unknown>;
          case_id?: string;
          case?: Record<string, unknown>;
        };
      const evalRunManager = manager();
      if ((eval_id === undefined) === (definition === undefined)) throw bad("Provide exactly one of eval_id or definition");
      if ((case_id === undefined) === (caseInput === undefined)) throw bad("Provide exactly one of case_id or case");
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
      });
      audit("eval_try", "ok");
      return tryResultToWire(tried);
    },
  );

  tool(
    "get_eval_run_export",
    "Export one eval run. what results (default) is the run detail plus every result row. what config is the config snapshot written when the run started. Read-only, free. Same body as GET /api/eval-runs/:id/export. Grader failures are codes.",
    z.object({
      eval_run_id: z.string(),
      what: z.enum(["results", "config"]).optional().describe('Default "results"'),
    }),
    async ({ eval_run_id, what }) => {
      manager();
      const row = await runByIdOr404(store, eval_run_id);
      return buildExport({ store, row, what: what ?? "results" });
    },
  );

  tool(
    "put_eval_review",
    "Set the review label, note, or failure-type tags on one repeat of an eval result. Tags are stored only on results that failed; tagging a passed result fails EVAL_TAGS_ON_PASSED_RESULT. Same as PUT /api/eval-runs/:id/results/:case_id/:repeat/review. Does not call a model.",
    z.object({
      eval_run_id: z.string(),
      case_id: z.string(),
      repeat_index: z.number().int().min(0),
      label: z.string().optional().describe("pass or fail"),
      note: z.string().nullable().optional(),
      tags: z.array(z.string()).optional().describe("Failure types; only on a failed result"),
    }),
    async ({ eval_run_id, case_id, repeat_index, label, note, tags }) => {
      manager();
      await runByIdOr404(store, eval_run_id);
      const patch: { label?: "pass" | "fail"; note?: string | null; tags?: string[] } = {};
      if (label !== undefined) {
        if (!(EVAL_REVIEW_LABELS as readonly string[]).includes(label)) throw bad(`"label" must be pass or fail`);
        patch.label = label as "pass" | "fail";
      }
      if (note !== undefined) {
        if (note !== null && note.length > EVAL_LIMITS.reviewNoteMaxChars) {
          throw bad(`"note" must be a string of at most ${EVAL_LIMITS.reviewNoteMaxChars} characters or null`);
        }
        patch.note = note;
      }
      if (tags !== undefined) {
        if (tags.some((t) => t.length > EVAL_LIMITS.failureTypeNameMaxChars)) {
          throw bad(`Each tag must be at most ${EVAL_LIMITS.failureTypeNameMaxChars} characters`);
        }
        patch.tags = tags;
      }
      try {
        const review = await store.putEvalReview(eval_run_id, case_id, repeat_index, patch);
        audit("eval_review", "ok", eval_run_id);
        return { label: review.label, note: review.note, tags: review.tags };
      } catch (err) {
        if (err instanceof EvalStoreError) throw err;
        if (err instanceof Error) throw bad(err.message);
        throw err;
      }
    },
  );

  tool(
    "accept_eval_failure_suggestions",
    "Accept pending failure suggestions for an eval run and write their failure types as tags. Pass ids to accept those rows, or min_confidence and bucket to accept every pending suggestion that matches (unclear is never included). Tags land only on failed results. Same as POST /api/eval-runs/:id/failures/suggestions/accept. Does not call a model.",
    z.object({
      eval_run_id: z.string(),
      ids: z.array(z.string()).optional().describe("Suggestion ids to accept; omit to accept by confidence and bucket"),
      min_confidence: z.number().optional().describe("Lowest confidence to accept when ids is omitted, from 0 to 1"),
      bucket: z.string().optional().describe(`Only this bucket when ids is omitted: ${TRIAGE_BUCKETS.join(", ")}`),
    }),
    async ({ eval_run_id, ids, min_confidence, bucket }) => {
      manager();
      const row = await runByIdOr404(store, eval_run_id);
      if (min_confidence !== undefined && (min_confidence < 0 || min_confidence > 1)) {
        throw bad(`"min_confidence" must be a number from 0 to 1`);
      }
      if (bucket !== undefined && !isTriageBucket(bucket)) throw bad(`"bucket" must be one of ${TRIAGE_BUCKETS.join(", ")}`);
      const result = await triage().accept(row, {
        ...(ids !== undefined ? { ids } : {}),
        ...(min_confidence !== undefined ? { minConfidence: min_confidence } : {}),
        ...(isTriageBucket(bucket) ? { bucket } : {}),
      });
      audit("eval_suggestions_accept", "ok", eval_run_id);
      return result;
    },
  );

  tool(
    "dismiss_eval_failure_suggestions",
    "Dismiss failure suggestions so they are not tagged. ids are required. Same as POST /api/eval-runs/:id/failures/suggestions/dismiss. Does not call a model.",
    z.object({
      eval_run_id: z.string(),
      ids: z.array(z.string()).describe("Suggestion ids to dismiss"),
    }),
    async ({ eval_run_id, ids }) => {
      manager();
      const row = await runByIdOr404(store, eval_run_id);
      const result = await triage().dismiss(row, ids);
      audit("eval_suggestions_dismiss", "ok", eval_run_id);
      return result;
    },
  );

  tool(
    "delete_eval_run",
    "Delete a finished eval run, its results, and the stage runs it recorded. A queued or running run fails EVAL_RUN_ACTIVE; cancel it first. Agent eval sessions for the run are deleted with it and are not listed anywhere else. Same as DELETE /api/eval-runs/:id.",
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
