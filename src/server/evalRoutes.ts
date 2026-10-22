import { formatId, nextIdNumber } from "../config/datasetImport.js";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveCatalogStartInput,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { EvalsWriteError, FileChangedError, contentHash } from "../config/atomicWrite.js";
import { casesFromRuns, listDatasetCandidates } from "../config/datasetCandidates.js";
import { checkDatasetAgainstStage } from "../config/datasetStageCheck.js";
import type { DatasetCase } from "../config/datasetTypes.js";
import { listDatasetFiles, listEvalFiles, loadEvalCatalog } from "../config/evalCatalog.js";
import {
  assertInsideProject,
  datasetIdsFor,
  datasetStem,
  findDatasetFile,
  findEvalFile,
  manifestForWrite,
  resolveWriteDir,
} from "../config/evalWriteRoots.js";
import { installEvalSample, EVAL_SAMPLE_FILES } from "../config/installEvalSample.js";
import { loadDatasetFile, parseDatasetText } from "../config/loadDataset.js";
import { loadEvalOutcome, resolveEvalPaths, type LoadedEval } from "../config/loadEval.js";
import { resolveEvalTarget } from "../config/resolveEvalTarget.js";
import { resolveSeededExamplesPath } from "../config/seededCatalog.js";
import {
  applyCaseOps,
  appendOrReplaceCases,
  convertDatasetToJsonl,
  createDatasetFile,
  type CaseOp,
  type NewDatasetCase,
} from "../config/writeDataset.js";
import {
  createEvalFile,
  previewEvalUpdate,
  renderEvalCreateYaml,
  renderEvalYaml,
  updateEvalFile,
} from "../config/writeEval.js";
import { CompareMismatchError } from "../evals/compare.js";
import { EVAL_LIMITS, EVAL_REVIEW_LABELS, EVAL_STARTED_VIA } from "../evals/constants.js";
import { PINNED_PROMPTFOO_VERSION } from "../evals/engine/promptfoo/pinned.js";
import type { EngineStatus } from "../evals/engine/promptfoo/status.js";
import { estimateRun, type EstimatePreviousRun } from "../evals/estimate.js";
import { EvalRunError, type EvalRunManager, type TryCaseInput, type TryResult } from "../evals/manager.js";
import { buildEvalPlan, type EvalOverrides } from "../evals/plan.js";
import {
  badRequest,
  buildEvalDetail,
  buildResultDetail,
  buildResultsPage,
  DEFAULT_LIMIT,
  ENGINE_NAME,
  engineCheck as engineCheckStatus,
  EvalApiError,
  evalScopeRoots,
  listEvalRunsPage,
  loadAggregatedEvalList,
  locateDataset,
  locateEval,
  locateEvalRoot,
  wireRootOf,
  MAX_LIMIT,
  planFindings as planFindingsShared,
  rel,
  runByIdOr404 as runByIdOr404Shared,
  validateEvalText,
} from "../evals/read/api.js";
import { buildCompare } from "../evals/read/compare.js";
import {
  buildDatasetDetail,
  previewUpload,
  resolveDatasetTarget,
  type DatasetDetail,
  type DatasetListItem,
  type DatasetTarget,
} from "../evals/read/datasets.js";
import { buildEvalListItems, costLastSevenDays, type EvalListItem } from "../evals/read/list.js";
import {
  buildExport,
  buildRunDetail,
  completedRunsNewestFirst,
  statsOfRun,
  type WireResultDetail,
} from "../evals/read/runs.js";
import { EvalStoreError } from "../evals/storeError.js";
import type { EvalRunRow } from "../evals/storeTypes.js";
import type { EvalFile, EvalPlan } from "../evals/types.js";
import { writeAudit } from "../logging/audit.js";
import type { Logger } from "../logging/logger.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import { callerIdFromRequestAuth, getRequestAuth } from "./requestAuthContext.js";

export type EvalRoutesDeps = {
  cwd: string;
  store: RunStore;
  manager: RunManager;
  evalRunManager: EvalRunManager | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  auditLog: Logger;
  engineStatus: () => EngineStatus;
  isKnownModel?: (id: string) => Promise<boolean>;
  sampleSourceDir?: string;
  now?: () => Date;
};

type Ctx = EvalRoutesDeps & {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  evalRunManager: EvalRunManager;
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANCEL_WAIT_MS = 5000;

const WRITE_ERROR_STATUS: Record<string, number> = {
  EVAL_EXISTS: 409,
  EVAL_NOT_FOUND: 404,
  EVAL_INVALID: 422,
  EVAL_DEFINITION_ID_MISMATCH: 422,
  DATASET_EXISTS: 409,
  DATASET_NOT_FOUND: 404,
  DATASET_INVALID: 422,
  DATASET_READ_ONLY: 409,
  DATASET_CASE_OP_INVALID: 422,
  DATASET_NAME_INVALID: 400,
  SAMPLE_EXISTS: 409,
  SAMPLE_SOURCE_MISSING: 500,
};

const RUN_ERROR_STATUS: Record<string, number> = {
  EVAL_INVALID: 422,
  EVAL_RUN_ACTIVE: 409,
  EVAL_RUN_NOT_FOUND: 404,
  EVAL_ENGINE_UNAVAILABLE: 503,
  EVAL_NODE_TOO_OLD: 503,
  EVAL_TAGS_ON_PASSED_RESULT: 400,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string, code = "invalid_request"): EvalApiError {
  return badRequest(message, code);
}

function sendError(c: Ctx, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  c.json(c.res, status, { error: message, code, ...extra });
}

function surface() {
  return getRequestAuth()?.surface ?? "rest";
}

function audit(c: Ctx, action: string, outcome: "ok" | "error", target?: string, code?: string): void {
  writeAudit(c.auditLog, {
    caller_id: callerIdFromRequestAuth(),
    surface: surface(),
    action,
    outcome,
    ...(target !== undefined ? { target_run_id: target } : {}),
    ...(code !== undefined ? { error_code: code } : {}),
  });
}

async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.readJsonBody(c.req);
  } catch {
    throw bad("Invalid JSON body");
  }
  if (!isRecord(body)) throw bad("Body must be a JSON object");
  return body;
}

async function readOptionalBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.readJsonBody(c.req);
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw bad(`"${key}" must be a non-empty string`);
  return value;
}

function optStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
    throw bad(`"${key}" must be an array of non-empty strings`);
  }
  return value as string[];
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw bad(`"${name}" must be an integer >= ${min}`);
  return Math.min(n, max);
}

function listParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams
    .getAll(name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return values.length > 0 ? values : undefined;
}

async function projectRootFor(c: Ctx, wire: string | undefined, write = false): Promise<string> {
  const options = { store: c.store, bootCwd: c.cwd };
  if (write) return (await resolveWritableCatalogRoot(options, wire)).wireRoot.path;
  if (wire === undefined) {
    try {
      return (await resolveCatalogStartInput(options, wire)).wireRoot.path;
    } catch (err) {
      if (!(err instanceof CatalogPathError)) throw err;
      return (await resolveWritableCatalogRoot(options)).wireRoot.path;
    }
  }
  return (await resolveCatalogStartInput(options, wire)).wireRoot.path;
}

function rootOptions(c: Ctx) {
  return { store: c.store, bootCwd: c.cwd };
}

async function evalRootFor(c: Ctx, wire: string | undefined, id: string, write = false) {
  return locateEval(rootOptions(c), wire, id, write);
}

function wireFromQuery(c: Ctx): string | undefined {
  return c.url.searchParams.get("project_root") ?? undefined;
}

function wireFromBody(body: Record<string, unknown>): string | undefined {
  const value = body.project_root;
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

function engineCheck(c: Ctx): void {
  engineCheckStatus(c.engineStatus());
}

async function runByIdOr404(c: Ctx, id: string): Promise<EvalRunRow> {
  return runByIdOr404Shared(c.store, id);
}

function catalogOptions(c: Ctx) {
  return c.isKnownModel ? { isKnownModel: c.isKnownModel } : {};
}

async function evalDetail(c: Ctx, projectRoot: string, absPath: string) {
  return buildEvalDetail({
    store: c.store,
    projectRoot,
    absPath,
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
}

async function planFindings(c: Ctx, projectRoot: string, evalPath: string, evalText: string) {
  return planFindingsShared({
    projectRoot,
    evalPath,
    evalText,
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
}

function targetLabelFilter(items: EvalListItem[], projectRoot: string, url: URL): EvalListItem[] {
  const pipeline = url.searchParams.get("target_pipeline");
  const stage = url.searchParams.get("target_stage");
  const file = url.searchParams.get("target_file");
  const same = (a: string | undefined, b: string): boolean =>
    a !== undefined && path.resolve(projectRoot, a) === path.resolve(projectRoot, b);
  return items.filter((item) => {
    if (pipeline !== null && !same(item.target.pipeline_path, pipeline)) return false;
    if (stage !== null && item.target.stage_id !== stage) return false;
    if (file !== null && !same(item.target.file, file)) return false;
    return true;
  });
}

async function writeRoots(c: Ctx) {
  const projectRoot = await projectRootFor(c, wireFromQuery(c), true);
  const manifest = await manifestForWrite(projectRoot);
  const [evals, datasets] = await Promise.all([
    resolveWriteDir(projectRoot, manifest, "evals"),
    resolveWriteDir(projectRoot, manifest, "datasets"),
  ]);
  return { project_root: projectRoot, evals_dir: evals.relDir, datasets_dir: datasets.relDir };
}

async function handleEvalList(c: Ctx): Promise<void> {
  const aggregated = await loadAggregatedEvalList({
    options: rootOptions(c),
    wire: wireFromQuery(c),
    now: c.now?.() ?? new Date(),
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
  const q = c.url.searchParams.get("q")?.trim().toLowerCase();
  const filtered = aggregated.groups
    .flatMap((g) => targetLabelFilter(g.items, g.root.path, c.url))
    .filter((item) => {
      if (q === undefined || q === "") return true;
      const dataset = path.basename(item.dataset_path).replace(/\.dataset\.(jsonl|json|csv)$/, "");
      return [item.id, item.name, item.target.stage_id ?? "", dataset].some((v) => v.toLowerCase().includes(q));
    });
  c.json(c.res, 200, {
    items: filtered,
    next_cursor: null,
    banner: aggregated.banner,
    ...(await writeRoots(c).then(
      (roots) => ({ write_roots: roots }),
      () => ({}),
    )),
    footer: {
      evals: aggregated.items.length,
      datasets: aggregated.datasets,
      cost_last_7_days: aggregated.cost,
    },
  });
}

function optDatasetCases(body: Record<string, unknown>): unknown[] | undefined {
  const value = body.dataset_cases;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw bad(`"dataset_cases" must be an array`);
  return withAssignedIds(value);
}

function withAssignedIds(cases: unknown[]): unknown[] {
  const isObject = (c: unknown): c is Record<string, unknown> =>
    c !== null && typeof c === "object" && !Array.isArray(c);
  const hasId = (c: unknown): boolean => isObject(c) && typeof c.id === "string" && c.id !== "";
  const existing = cases.filter(hasId).map((c) => (c as { id: string }).id);
  let next = nextIdNumber(existing);
  return cases.map((c) => (isObject(c) && !hasId(c) ? { ...c, id: formatId(next++) } : c));
}

function parseDefinitionOrYaml(body: Record<string, unknown>): { definition?: unknown; yaml?: string } {
  const hasDefinition = body.definition !== undefined;
  const hasYaml = body.yaml !== undefined;
  if (hasDefinition === hasYaml) throw bad("Provide exactly one of definition or yaml");
  if (hasYaml) {
    if (typeof body.yaml !== "string") throw bad(`"yaml" must be a string`);
    return { yaml: body.yaml };
  }
  if (!isRecord(body.definition)) throw bad(`"definition" must be an object`);
  return { definition: body.definition };
}

async function handleEvalValidate(c: Ctx): Promise<void> {
  const body = await readBody(c);
  const input = parseDefinitionOrYaml(body);
  const projectRoot = await projectRootFor(c, wireFromBody(body));
  const manifest = await manifestForWrite(projectRoot);
  const suppliedPath = optString(body, "path");
  const datasetCases = optDatasetCases(body);

  let evalAbs: string;
  if (suppliedPath !== undefined) {
    evalAbs = path.resolve(projectRoot, suppliedPath);
    assertInsideProject(projectRoot, evalAbs, "eval path");
  } else {
    const rawId = isRecord(input.definition) ? input.definition.id : undefined;
    const dir = await resolveWriteDir(projectRoot, manifest, "evals");
    const fileName = typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml";
    evalAbs = path.join(dir.absDir, fileName);
  }

  let derived: string;
  if (input.yaml !== undefined) {
    derived = input.yaml.endsWith("\n") ? input.yaml : `${input.yaml}\n`;
  } else if (await exists(evalAbs)) {
    derived = previewEvalUpdate(await readFile(evalAbs, "utf8"), input.definition);
  } else {
    derived = renderEvalCreateYaml(input.definition as EvalFile);
  }

  const { findings, parsed } = await validateEvalText({
    projectRoot,
    evalAbs,
    derived,
    ...(datasetCases !== undefined ? { datasetCases } : {}),
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
  c.json(c.res, 200, {
    findings,
    derived_yaml: derived,
    definition: parsed.ok ? parsed.value.file : null,
  });
}

async function handleEvalCreate(c: Ctx): Promise<void> {
  const body = await readBody(c);
  if (!isRecord(body.definition)) throw bad(`"definition" must be an object`);
  const definition = body.definition as unknown as EvalFile;
  const directory = optString(body, "directory");
  const projectRoot = await projectRootFor(c, wireFromBody(body), true);
  const manifest = await manifestForWrite(projectRoot);
  const dir = await resolveWriteDir(projectRoot, manifest, "evals", directory);
  const rawId = (definition as { id?: unknown }).id;
  const fileName = typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml";
  const absPath = path.join(dir.absDir, fileName);
  assertInsideProject(projectRoot, absPath, "eval path");

  if (typeof rawId === "string" && (await findEvalFile(projectRoot, rawId, manifest)) !== undefined) {
    throw new EvalsWriteError("EVAL_EXISTS", `Eval "${rawId}" already exists`);
  }
  const text = renderEvalCreateYaml(definition);
  const checked = await planFindings(c, projectRoot, absPath, text);
  if (!checked.ok) {
    audit(c, "eval_create", "error", undefined, "EVAL_INVALID");
    throw new EvalApiError(422, "EVAL_INVALID", "Eval definition is invalid", { findings: checked.findings });
  }
  const written = await createEvalFile({ projectRoot, definition, ...(directory !== undefined ? { directory } : {}) });
  audit(c, "eval_create", "ok");
  c.json(c.res, 201, await evalDetail(c, projectRoot, written.path));
}

async function handleEvalGet(c: Ctx, id: string): Promise<void> {
  const { projectRoot, ref } = await evalRootFor(c, wireFromQuery(c), id);
  c.json(c.res, 200, await evalDetail(c, projectRoot, ref.absPath));
}

async function handleEvalUpdate(c: Ctx, id: string): Promise<void> {
  const body = await readBody(c);
  const input = parseDefinitionOrYaml(body);
  const baseHash = body.base_hash;
  if (typeof baseHash !== "string" || baseHash === "") throw bad(`"base_hash" is required`);
  const { projectRoot, ref } = await evalRootFor(c, wireFromBody(body), id, true);
  const current = await readFile(ref.absPath);
  const currentHash = contentHash(current);
  if (currentHash !== baseHash) throw new FileChangedError(currentHash);
  const text =
    input.yaml !== undefined
      ? input.yaml.endsWith("\n")
        ? input.yaml
        : `${input.yaml}\n`
      : previewEvalUpdate(current.toString("utf8"), input.definition);
  const checked = await planFindings(c, projectRoot, ref.absPath, text);
  if (!checked.ok) {
    audit(c, "eval_update", "error", undefined, "EVAL_INVALID");
    throw new EvalApiError(422, "EVAL_INVALID", "Eval definition is invalid", { findings: checked.findings });
  }
  await updateEvalFile({
    projectRoot,
    id,
    baseHash,
    ...(input.yaml !== undefined ? { yaml: input.yaml } : { definition: input.definition }),
  });
  audit(c, "eval_update", "ok");
  c.json(c.res, 200, await evalDetail(c, projectRoot, ref.absPath));
}

async function handleSampleInstall(c: Ctx): Promise<void> {
  const body = await readOptionalBody(c);
  const projectRoot = await projectRootFor(c, wireFromBody(body), true);
  try {
    const result = await installEvalSample({
      projectRoot,
      ...(c.sampleSourceDir !== undefined ? { sourceDir: c.sampleSourceDir } : {}),
    });
    audit(c, "eval_sample_install", "ok");
    c.json(c.res, 201, { eval_id: result.evalId });
  } catch (err) {
    if (err instanceof EvalsWriteError) audit(c, "eval_sample_install", "error", undefined, err.code);
    throw err;
  }
}

function tryCaseFrom(value: unknown): TryCaseInput {
  if (!isRecord(value) || !isRecord(value.input)) throw bad(`"case" must be an object with an input object`);
  return value as unknown as TryCaseInput;
}

function tryResultToWire(result: TryResult): { result: WireResultDetail; stage_run_id: string | null; cost_usd: number } {
  const r = result.result;
  return {
    result: {
      case_id: r.caseId,
      repeat_index: 0,
      status: r.status,
      error_code: r.errorCode,
      error_message: r.errorMessage,
      stage_run_id: r.stageRunId,
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

async function handleTry(c: Ctx): Promise<void> {
  const body = await readBody(c);
  const evalId = optString(body, "eval_id");
  const hasDefinition = body.definition !== undefined;
  if ((evalId === undefined) === !hasDefinition) throw bad("Provide exactly one of eval_id or definition");
  const caseId = optString(body, "case_id");
  const datasetCases = optDatasetCases(body);
  const hasCase = body.case !== undefined;
  if ((caseId === undefined) === !hasCase) throw bad("Provide exactly one of case_id or case");
  const located = evalId !== undefined ? await evalRootFor(c, wireFromBody(body), evalId) : undefined;
  const projectRoot = located?.projectRoot ?? (await projectRootFor(c, wireFromBody(body)));
  const manifest = await manifestForWrite(projectRoot);

  let evalPath: string;
  let definition: EvalFile | undefined;
  if (located !== undefined) {
    evalPath = located.ref.absPath;
  } else {
    if (!isRecord(body.definition)) throw bad(`"definition" must be an object`);
    definition = body.definition as unknown as EvalFile;
    const rawId = (definition as { id?: unknown }).id;
    const dir = await resolveWriteDir(projectRoot, manifest, "evals");
    evalPath = path.join(dir.absDir, typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml");
  }
  engineCheck(c);
  const tried = await c.evalRunManager.tryOne({
    projectRoot,
    evalPath,
    ...(definition !== undefined ? { definition } : {}),
    ...(datasetCases !== undefined ? { datasetCases } : {}),
    ...(caseId !== undefined ? { caseId } : { case: tryCaseFrom(body.case) }),
  });
  audit(c, "eval_try", "ok");
  c.json(c.res, 200, tryResultToWire(tried));
}

function startOverrides(body: Record<string, unknown>): EvalOverrides {
  const overrides: EvalOverrides = {};
  if (body.repeats !== undefined) {
    if (typeof body.repeats !== "number") throw bad(`"repeats" must be a number`);
    overrides.repeats = body.repeats;
  }
  const judge = optString(body, "judge");
  if (judge !== undefined) overrides.judge = judge;
  const model = optString(body, "model");
  if (model !== undefined) overrides.model = model;
  if (body.max_cost_usd !== undefined) {
    if (typeof body.max_cost_usd !== "number") throw bad(`"max_cost_usd" must be a number`);
    overrides.max_cost_usd = body.max_cost_usd;
  }
  const caseIds = optStringArray(body, "case_ids");
  if (caseIds !== undefined) overrides.case_ids = caseIds;
  const tags = optStringArray(body, "tags");
  if (tags !== undefined) overrides.tags = tags;
  const failedFrom = optString(body, "only_failed_from");
  if (failedFrom !== undefined) overrides.only_failed_from = failedFrom;
  return overrides;
}

function queryOverrides(url: URL): EvalOverrides {
  const body: Record<string, unknown> = {};
  const num = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw bad(`"${name}" must be a number`);
    return n;
  };
  const repeats = num("repeats");
  if (repeats !== undefined) body.repeats = repeats;
  const maxCost = num("max_cost_usd");
  if (maxCost !== undefined) body.max_cost_usd = maxCost;
  for (const key of ["judge", "model", "only_failed_from"]) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") body[key] = value;
  }
  const caseIds = listParam(url, "case_ids");
  if (caseIds) body.case_ids = caseIds;
  const tags = listParam(url, "tags");
  if (tags) body.tags = tags;
  return startOverrides(body);
}

async function failedCaseIdsOf(c: Ctx, projectRoot: string, evalPath: string, evalRunId: string) {
  const run = await c.store.getEvalRun(evalRunId);
  if (run === null || run.projectRoot !== projectRoot) return undefined;
  if (run.evalPath !== rel(projectRoot, path.resolve(projectRoot, evalPath))) return undefined;
  const results = await c.store.listEvalResults(evalRunId);
  const failed = results.filter(
    (r) => ["completed", "stage_failed", "needs_input", "error"].includes(r.status) && !r.passed,
  );
  return [...new Set(failed.map((r) => r.caseId))];
}

async function handleRunStart(c: Ctx, id: string): Promise<void> {
  const body = await readBody(c);
  const overrides = startOverrides(body);
  const label = optString(body, "label");
  if (label !== undefined && label.length > EVAL_LIMITS.labelMaxChars) {
    throw bad(`"label" must be at most ${EVAL_LIMITS.labelMaxChars} characters`);
  }
  const startedVia = body.started_via === undefined ? "console" : body.started_via;
  if (typeof startedVia !== "string" || !(EVAL_STARTED_VIA as readonly string[]).includes(startedVia)) {
    throw bad(`"started_via" must be one of ${EVAL_STARTED_VIA.join(", ")}`);
  }
  const { projectRoot, ref } = await evalRootFor(c, wireFromBody(body), id);
  engineCheck(c);
  try {
    const started = await c.evalRunManager.start({
      projectRoot,
      evalPath: ref.absPath,
      overrides,
      startedVia: startedVia as (typeof EVAL_STARTED_VIA)[number],
      ...(label !== undefined ? { label } : {}),
      ...(callerIdFromRequestAuth() !== null ? { callerId: callerIdFromRequestAuth() as string } : {}),
    });
    audit(c, "eval_run_start", "ok", started.evalRunId);
    c.json(c.res, 202, { eval_run_id: started.evalRunId, status: "queued", run_number: started.runNumber });
  } catch (err) {
    audit(c, "eval_run_start", "error", undefined, err instanceof EvalRunError ? err.code : "internal_error");
    throw err;
  }
}

async function recentStageCosts(c: Ctx, target: { pipelinePath?: string; stageId?: string }): Promise<number[]> {
  if (target.stageId === undefined) return [];
  const pipelines = [`standalone-${target.stageId}`];
  if (target.pipelinePath !== undefined) pipelines.push(target.pipelinePath);
  const summaries = (await Promise.all(pipelines.map((pipeline) => c.store.listRuns({ pipeline })))).flat();
  summaries.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const costs: number[] = [];
  for (const summary of summaries) {
    for (const stage of summary.stages) {
      if (stage.id === target.stageId && stage.cost_usd !== undefined) costs.push(stage.cost_usd);
    }
    if (costs.length >= 20) break;
  }
  return costs.slice(0, 20);
}

async function handleRunEstimate(c: Ctx, id: string): Promise<void> {
  const { projectRoot, ref } = await evalRootFor(c, wireFromQuery(c), id);
  const overrides = queryOverrides(c.url);
  const built = await buildEvalPlan({
    projectRoot,
    evalPath: ref.absPath,
    overrides,
    evalRunId: "er_estimate",
    engine: { name: ENGINE_NAME, version: PINNED_PROMPTFOO_VERSION, nodeVersion: process.versions.node },
    failedCaseIdsOf: (runId) => failedCaseIdsOf(c, projectRoot, ref.absPath, runId),
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
  if (!built.ok) throw new EvalApiError(422, "EVAL_INVALID", "Eval is invalid", { findings: built.findings });
  const { plan } = built;
  const last = (await completedRunsNewestFirst(c.store, projectRoot, plan.evalId, 1))[0];
  let previous: EstimatePreviousRun | null = null;
  if (last) {
    const results = await c.store.listEvalResults(last.evalRunId);
    const stats = statsOfRun(last, results);
    previous = {
      runNumber: last.runNumber,
      costStage: stats.cost_stage,
      costJudge: stats.cost_judge,
      resultsExecuted: stats.results_executed,
      rubricGradesGraded: results
        .flatMap((r) => r.grades)
        .filter((g) => g.graderType === "rubric" && g.status === "graded").length,
      wallSeconds:
        last.startedAt !== null && last.finishedAt !== null
          ? Math.max(0, (Date.parse(last.finishedAt) - Date.parse(last.startedAt)) / 1000)
          : null,
    };
  }
  await sendEstimate(c, plan, previous);
}

async function sendEstimate(c: Ctx, plan: EvalPlan, previous: EstimatePreviousRun | null): Promise<void> {
  const estimate = estimateRun({
    resultsTotal: plan.cases.length * plan.repeats,
    rubricGraderCount: plan.graders.filter((g) => g.type === "rubric").length,
    previous,
    recentStageCosts: await recentStageCosts(c, {
      ...(plan.target.kind === "stage" && plan.target.pipelinePath !== undefined ? { pipelinePath: plan.target.pipelinePath } : {}),
      ...(plan.target.kind === "stage" && plan.target.stageId !== undefined ? { stageId: plan.target.stageId } : {}),
    }),
  });
  c.json(c.res, 200, {
    results_total: plan.cases.length * plan.repeats,
    stage_calls: estimate.stage_calls,
    judge_calls: estimate.judge_calls,
    estimate_usd: estimate.estimate_usd,
    estimate_seconds: estimate.estimate_seconds,
    judge_included: !estimate.judge_excluded,
    based_on_run_number: estimate.based_on_run_number,
  });
}

async function handleDraftEstimate(c: Ctx): Promise<void> {
  const body = await readBody(c);
  if (!isRecord(body.definition)) throw bad(`"definition" must be an object`);
  const definition = body.definition as unknown as EvalFile;
  const datasetCases = optDatasetCases(body);
  const overrides = startOverrides({ ...(body.repeats !== undefined ? { repeats: body.repeats } : {}) });
  const projectRoot = await projectRootFor(c, wireFromBody(body));
  const manifest = await manifestForWrite(projectRoot);
  const dir = await resolveWriteDir(projectRoot, manifest, "evals");
  const rawId = (definition as { id?: unknown }).id;
  const evalPath = path.join(dir.absDir, typeof rawId === "string" && ID_RE.test(rawId) ? `${rawId}.eval.yaml` : "new.eval.yaml");
  assertInsideProject(projectRoot, evalPath, "eval path");
  const built = await buildEvalPlan({
    projectRoot,
    evalPath,
    evalText: renderEvalCreateYaml(definition),
    ...(datasetCases !== undefined ? { datasetCases } : {}),
    overrides,
    evalRunId: "er_estimate",
    engine: { name: ENGINE_NAME, version: PINNED_PROMPTFOO_VERSION, nodeVersion: process.versions.node },
    ...(c.isKnownModel ? { isKnownModel: c.isKnownModel } : {}),
  });
  if (!built.ok) throw new EvalApiError(422, "EVAL_INVALID", "Eval is invalid", { findings: built.findings });
  await sendEstimate(c, built.plan, null);
}

async function runDetailResponse(c: Ctx, row: EvalRunRow) {
  return buildRunDetail({ store: c.store, row, live: c.evalRunManager.getLive(row.evalRunId) });
}

async function handleRunByNumber(c: Ctx, id: string, runNumber: number): Promise<void> {
  const notFound = () => new EvalApiError(404, "EVAL_RUN_NOT_FOUND", `Eval run not found: ${id} #${runNumber}`);
  const wire = wireFromQuery(c);
  const found: Array<{ root: CatalogRoot; row: EvalRunRow }> = [];
  for (const root of await evalScopeRoots(rootOptions(c), wire)) {
    const row = await c.store.getEvalRunByNumber(root.path, id, runNumber);
    if (row !== null) found.push({ root, row });
  }
  if (found.length > 1) {
    throw new EvalApiError(409, "EVAL_AMBIGUOUS", `Eval "${id}" exists in more than one project; pass project_root`, {
      project_roots: found.map((f) => f.root.project_root),
    });
  }
  if (found[0] === undefined) throw notFound();
  c.json(c.res, 200, await runDetailResponse(c, found[0].row));
}

async function handleRunList(c: Ctx): Promise<void> {
  const wire = wireFromQuery(c);
  const projectRoot = wire !== undefined ? await projectRootFor(c, wire) : undefined;
  const wireRootOfPath = await wireRootOf(rootOptions(c));
  const evalId = c.url.searchParams.get("eval_id") ?? undefined;
  const status = c.url.searchParams.get("status") ?? undefined;
  const stageRunId = c.url.searchParams.get("stage_run_id") ?? undefined;
  const limit = intParam(c.url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cursor = c.url.searchParams.get("cursor") ?? undefined;
  c.json(
    c.res,
    200,
    await listEvalRunsPage(c.store, {
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      wireRootOf: wireRootOfPath,
      ...(evalId !== undefined ? { evalId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(stageRunId !== undefined ? { stageRunId } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  );
}

async function handleRunGet(c: Ctx, id: string): Promise<void> {
  c.json(c.res, 200, await runDetailResponse(c, await runByIdOr404(c, id)));
}

async function handleResultsList(c: Ctx, id: string): Promise<void> {
  const grader = c.url.searchParams.get("grader") ?? undefined;
  const q = c.url.searchParams.get("q") ?? undefined;
  const tag = c.url.searchParams.get("tag") ?? undefined;
  const status = c.url.searchParams.get("status") ?? undefined;
  c.json(
    c.res,
    200,
    await buildResultsPage(c.store, id, {
      ...(status !== undefined ? { status } : {}),
      ...(grader !== undefined ? { grader } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(tag !== undefined ? { tag } : {}),
      limit: intParam(c.url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
      cursor: c.url.searchParams.get("cursor"),
    }),
  );
}

async function handleResultDetail(c: Ctx, id: string, caseId: string): Promise<void> {
  c.json(c.res, 200, await buildResultDetail(c.store, id, caseId));
}

async function handleReviewPut(c: Ctx, id: string, caseId: string, repeat: number): Promise<void> {
  const body = await readBody(c);
  await runByIdOr404(c, id);
  const patch: { label?: "pass" | "fail"; note?: string | null; tags?: string[] } = {};
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !(EVAL_REVIEW_LABELS as readonly string[]).includes(body.label)) {
      throw bad(`"label" must be pass or fail`);
    }
    patch.label = body.label as "pass" | "fail";
  }
  if (body.note !== undefined) {
    if (body.note !== null && (typeof body.note !== "string" || body.note.length > EVAL_LIMITS.reviewNoteMaxChars)) {
      throw bad(`"note" must be a string of at most ${EVAL_LIMITS.reviewNoteMaxChars} characters or null`);
    }
    patch.note = body.note as string | null;
  }
  if (body.tags !== undefined) {
    const tags = optStringArray(body, "tags") ?? [];
    if (tags.some((t) => t.length > EVAL_LIMITS.failureTypeNameMaxChars)) {
      throw bad(`Each tag must be at most ${EVAL_LIMITS.failureTypeNameMaxChars} characters`);
    }
    patch.tags = tags;
  }
  try {
    const review = await c.store.putEvalReview(id, caseId, repeat, patch);
    audit(c, "eval_review", "ok", id);
    c.json(c.res, 200, { label: review.label, note: review.note, tags: review.tags });
  } catch (err) {
    if (err instanceof EvalStoreError) throw err;
    if (err instanceof Error) throw bad(err.message);
    throw err;
  }
}

async function handleFailureTypes(c: Ctx, id: string): Promise<void> {
  const root = await locateEvalRoot(rootOptions(c), wireFromQuery(c), id);
  c.json(c.res, 200, { items: await c.store.listFailureTypes(root.path, id), next_cursor: null });
}

async function handleCancel(c: Ctx, id: string): Promise<void> {
  await runByIdOr404(c, id);
  await c.evalRunManager.cancel(id);
  const { run } = await c.evalRunManager.awaitFinished(id, CANCEL_WAIT_MS);
  audit(c, "eval_run_cancel", "ok", id);
  c.json(c.res, 200, await runDetailResponse(c, run));
}

async function handleDelete(c: Ctx, id: string): Promise<void> {
  const row = await runByIdOr404(c, id);
  if (row.status === "queued" || row.status === "running") {
    throw new EvalApiError(409, "EVAL_RUN_ACTIVE", "Eval run is still running; cancel it first");
  }
  const stageRunIds = await c.store.deleteEvalRun(id);
  for (const runId of stageRunIds) {
    await c.manager.deleteRun(runId, { channel: "rest" }).catch(() => undefined);
  }
  audit(c, "eval_run_delete", "ok", id);
  c.res.writeHead(204);
  c.res.end();
}

async function handleCompare(c: Ctx): Promise<void> {
  const a = c.url.searchParams.get("a");
  const b = c.url.searchParams.get("b");
  if (!a || !b) throw bad(`"a" and "b" eval run ids are required`);
  const [left, right] = [await runByIdOr404(c, a), await runByIdOr404(c, b)];
  c.json(c.res, 200, await buildCompare(c.store, left, right));
}

async function handleExport(c: Ctx, id: string): Promise<void> {
  const row = await runByIdOr404(c, id);
  const what = c.url.searchParams.get("what") ?? "results";
  if (what !== "results" && what !== "config") throw bad(`"what" must be results or config`);
  const { filename, body } = await buildExport({ store: c.store, row, what });
  c.res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename=${filename}`,
  });
  c.res.end(JSON.stringify(body));
}

function handleEngine(c: Ctx): void {
  const status = c.engineStatus();
  c.json(c.res, 200, {
    installed: status.installed,
    version: status.version,
    pinned: status.pinned,
    node: status.node,
    node_ok: status.nodeOk,
    install_command: status.installCommand,
  });
}

type EvalUse = { id: string; loaded: LoadedEval };

async function loadEvalUses(projectRoot: string): Promise<{ uses: Map<string, EvalUse[]>; byId: Map<string, EvalUse> }> {
  const manifest = await manifestForWrite(projectRoot);
  const refs = await listEvalFiles(manifest);
  const uses = new Map<string, EvalUse[]>();
  const byId = new Map<string, EvalUse>();
  for (const ref of refs) {
    const outcome = await loadEvalOutcome(ref.absPath, projectRoot);
    if (!outcome.ok) continue;
    const use: EvalUse = { id: outcome.value.id, loaded: outcome.value };
    const { datasetPath } = resolveEvalPaths(outcome.value.file, outcome.value.path);
    const key = path.resolve(datasetPath);
    uses.set(key, [...(uses.get(key) ?? []), use]);
    if (!byId.has(use.id)) byId.set(use.id, use);
  }
  return { uses, byId };
}

async function handleDatasetList(c: Ctx): Promise<void> {
  const items: DatasetListItem[] = [];
  for (const root of await evalScopeRoots(rootOptions(c), wireFromQuery(c))) {
    const projectRoot = root.path;
    const manifest = await manifestForWrite(projectRoot);
    const { uses } = await loadEvalUses(projectRoot);
    const files = await listDatasetFiles(manifest);
    const ids = datasetIdsFor(files);
    for (const file of files) {
      const loaded = await loadDatasetFile(file.absPath, { root: projectRoot });
      items.push({
        project_root: root.project_root,
        id: ids.get(file.absPath) ?? datasetStem(path.basename(file.absPath)),
        path: file.relPath,
        format: loaded.format ?? null,
        cases: loaded.cases.length,
        hash: loaded.contentHash,
        editable: loaded.format === "jsonl",
        used_by: (uses.get(path.resolve(file.absPath)) ?? []).map((u) => u.id),
        findings_count: loaded.findings.length,
      });
    }
  }
  c.json(c.res, 200, { items, next_cursor: null });
}

async function datasetDetailFor(
  c: Ctx,
  projectRoot: string,
  id: string,
  absPath: string,
  evalId: string | undefined,
  query: { offset: number; limit: number; tag?: string; q?: string; filter: "all" | "invalid" | "tagged" },
): Promise<DatasetDetail> {
  const loaded = await loadDatasetFile(absPath, { root: projectRoot });
  const { uses, byId } = await loadEvalUses(projectRoot);
  const usedBy = (uses.get(path.resolve(absPath)) ?? []).map((u) => u.id);
  const useEval = evalId !== undefined ? byId.get(evalId) : byId.get(usedBy[0] ?? "");
  if (evalId !== undefined && useEval === undefined) {
    throw new EvalApiError(404, "EVAL_NOT_FOUND", `Eval not found: ${evalId}`);
  }
  let inputSchema: unknown;
  if (useEval !== undefined) {
    const target = await resolveEvalTarget(useEval.loaded.file, useEval.loaded.path, projectRoot);
    if (target.ok) inputSchema = target.value.inputSchema;
  }
  return buildDatasetDetail({
    id,
    loaded,
    inputSchema,
    hasEval: useEval !== undefined,
    usedBy,
    query,
  });
}

function datasetQuery(url: URL): { offset: number; limit: number; tag?: string; q?: string; filter: "all" | "invalid" | "tagged" } {
  const filter = url.searchParams.get("filter") ?? "all";
  if (filter !== "all" && filter !== "invalid" && filter !== "tagged") {
    throw bad(`"filter" must be all, invalid or tagged`);
  }
  const tag = url.searchParams.get("tag") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  return {
    offset: intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
    filter,
    ...(tag !== undefined ? { tag } : {}),
    ...(q !== undefined ? { q } : {}),
  };
}

async function handleDatasetGet(c: Ctx, id: string): Promise<void> {
  const { projectRoot, ref } = await locateDataset(rootOptions(c), wireFromQuery(c), id, { write: false, missing: "throw" });
  const evalId = c.url.searchParams.get("eval_id") ?? undefined;
  c.json(c.res, 200, await datasetDetailFor(c, projectRoot, id, (ref as NonNullable<typeof ref>).absPath, evalId, datasetQuery(c.url)));
}

function targetFrom(value: unknown): DatasetTarget {
  if (!isRecord(value)) throw bad(`"target" must be an object`);
  const target: DatasetTarget = {};
  for (const key of ["pipeline_path", "stage_id", "file"] as const) {
    const v = value[key];
    if (v !== undefined) {
      if (typeof v !== "string" || v === "") throw bad(`target.${key} must be a non-empty string`);
      target[key] = v;
    }
  }
  return target;
}

async function handleDatasetPreview(c: Ctx): Promise<void> {
  const body = await readBody(c);
  const format = body.format;
  if (format !== "jsonl" && format !== "json" && format !== "csv") throw bad(`"format" must be jsonl, json or csv`);
  if (typeof body.content !== "string") throw bad(`"content" must be a string`);
  const delimiter = body.delimiter;
  if (delimiter !== undefined && (typeof delimiter !== "string" || delimiter.length !== 1)) {
    throw bad(`"delimiter" must be a single character`);
  }
  let mapping;
  if (body.mapping !== undefined) {
    if (!isRecord(body.mapping)) throw bad(`"mapping" must be an object`);
    mapping = body.mapping as Record<string, { column: string; split?: string } | null>;
  }
  const projectRoot = await projectRootFor(c, wireFromBody(body));
  let inputSchema: unknown;
  if (body.target !== undefined) {
    const resolved = await resolveDatasetTarget(projectRoot, targetFrom(body.target));
    if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
    inputSchema = resolved.value.inputSchema;
  }
  c.json(c.res, 200, previewUpload({
    format,
    content: body.content,
    ...(delimiter !== undefined ? { delimiter: delimiter as string } : {}),
    ...(mapping !== undefined ? { mapping } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  }));
}

async function sampleCases(c: Ctx): Promise<DatasetCase[]> {
  const dir = c.sampleSourceDir ?? (() => {
    const examples = resolveSeededExamplesPath();
    return examples === undefined ? undefined : path.join(examples, "evals");
  })();
  if (dir === undefined) throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample files were not found");
  let text: string;
  try {
    text = await readFile(path.join(dir, EVAL_SAMPLE_FILES.dataset), "utf8");
  } catch {
    throw new EvalsWriteError("SAMPLE_SOURCE_MISSING", "The packaged sample dataset was not found");
  }
  return parseDatasetText(text, "jsonl").cases;
}

async function casesFromRunsBody(c: Ctx, projectRoot: string, body: Record<string, unknown>): Promise<NewDatasetCase[]> {
  const resolved = await resolveDatasetTarget(projectRoot, targetFrom(body.target));
  if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
  const runIds = optStringArray(body, "run_ids");
  if (!runIds || runIds.length === 0) throw bad(`"run_ids" must be a non-empty array`);
  if (resolved.value.stageId === undefined) throw bad("target does not name a stage");
  return casesFromRuns({
    store: c.store,
    runIds,
    target: {
      stageId: resolved.value.stageId,
      ...(resolved.value.pipelineAbsPath !== undefined ? { pipelinePath: resolved.value.pipelineAbsPath } : {}),
    },
  });
}

async function handleDatasetCreate(c: Ctx): Promise<void> {
  const body = await readBody(c);
  const projectRoot =
    typeof body.dataset_id === "string" && body.dataset_id !== ""
      ? (await locateDataset(rootOptions(c), wireFromBody(body), body.dataset_id, { write: true, missing: "default" })).projectRoot
      : await projectRootFor(c, wireFromBody(body), true);
  const directory = optString(body, "directory");
  let absPath: string;
  let id: string;

  if (body.dataset_id !== undefined) {
    id = optString(body, "dataset_id") as string;
    const mode = body.mode;
    if (mode !== "append" && mode !== "replace") throw bad(`"mode" must be append or replace`);
    if (typeof body.base_hash !== "string" || body.base_hash === "") throw bad(`"base_hash" is required`);
    let newCases: NewDatasetCase[];
    if (body.source === "runs") {
      if (mode !== "append") throw bad(`source "runs" requires mode "append"`);
      newCases = await casesFromRunsBody(c, projectRoot, body);
    } else {
      if (!Array.isArray(body.cases)) throw bad(`"cases" must be an array`);
      newCases = body.cases as NewDatasetCase[];
    }
    const written = await appendOrReplaceCases({
      projectRoot,
      id,
      baseHash: body.base_hash,
      mode,
      cases: newCases,
    });
    absPath = written.path;
  } else {
    const name = optString(body, "name");
    if (name === undefined) throw bad(`"name" is required`);
    id = name;
    let cases: NewDatasetCase[];
    if (body.source === "sample" || body.source === "runs") {
      const target = targetFrom(body.target);
      const resolved = await resolveDatasetTarget(projectRoot, target);
      if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
      if (body.source === "sample") {
        const sample = await sampleCases(c);
        cases = sample;
        const failing = checkDatasetAgainstStage(sample, resolved.value.inputSchema).find((r) => !r.valid);
        if (failing) {
          throw new EvalsWriteError("DATASET_INVALID", "The sample cases do not match this stage's input");
        }
      } else {
        cases = await casesFromRunsBody(c, projectRoot, body);
      }
    } else {
      if (!Array.isArray(body.cases)) throw bad(`"cases" must be an array`);
      cases = body.cases as NewDatasetCase[];
    }
    const written = await createDatasetFile({
      projectRoot,
      name,
      cases,
      ...(directory !== undefined ? { directory } : {}),
    });
    absPath = written.path;
  }
  audit(c, "dataset_write", "ok");
  c.json(c.res, 201, await datasetDetailFor(c, projectRoot, id, absPath, undefined, { offset: 0, limit: MAX_LIMIT, filter: "all" }));
}

const CASE_OPS = new Set(["add", "update", "delete", "set_tags"]);

async function handleDatasetPatch(c: Ctx, id: string): Promise<void> {
  const body = await readBody(c);
  if (typeof body.base_hash !== "string" || body.base_hash === "") throw bad(`"base_hash" is required`);
  if (!Array.isArray(body.ops) || body.ops.some((op) => !isRecord(op) || !CASE_OPS.has(String(op.op)))) {
    throw bad(`"ops" must be an array of add, update, delete or set_tags operations`);
  }
  const { projectRoot } = await locateDataset(rootOptions(c), wireFromBody(body), id, { write: true, missing: "default" });
  const written = await applyCaseOps({
    projectRoot,
    id,
    baseHash: body.base_hash,
    ops: body.ops as CaseOp[],
  });
  audit(c, "dataset_write", "ok");
  c.json(c.res, 200, await datasetDetailFor(c, projectRoot, id, written.path, undefined, { offset: 0, limit: MAX_LIMIT, filter: "all" }));
}

async function handleDatasetConvert(c: Ctx, id: string): Promise<void> {
  const body = await readBody(c);
  if (typeof body.base_hash !== "string" || body.base_hash === "") throw bad(`"base_hash" is required`);
  const { projectRoot } = await locateDataset(rootOptions(c), wireFromBody(body), id, { write: true, missing: "default" });
  const written = await convertDatasetToJsonl({ projectRoot, id, baseHash: body.base_hash });
  audit(c, "dataset_write", "ok");
  c.json(c.res, 201, await datasetDetailFor(c, projectRoot, written.id, written.path, undefined, { offset: 0, limit: MAX_LIMIT, filter: "all" }));
}

async function handleCandidates(c: Ctx): Promise<void> {
  const projectRoot = await projectRootFor(c, wireFromQuery(c));
  const target: DatasetTarget = {};
  for (const key of ["pipeline_path", "stage_id", "file"] as const) {
    const v = c.url.searchParams.get(key);
    if (v !== null && v !== "") target[key] = v;
  }
  const resolved = await resolveDatasetTarget(projectRoot, target);
  if (!resolved.ok) throw new EvalApiError(422, "EVAL_INVALID", resolved.message);
  if (resolved.value.stageId === undefined) throw bad("target does not name a stage");
  const items = await listDatasetCandidates({
    store: c.store,
    target: {
      stageId: resolved.value.stageId,
      ...(resolved.value.pipelineAbsPath !== undefined ? { pipelinePath: resolved.value.pipelineAbsPath } : {}),
    },
    limit: intParam(c.url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
  });
  c.json(c.res, 200, {
    items: items.map((i) => ({ run_id: i.runId, finished_at: i.finishedAt, preview: i.preview })),
    next_cursor: null,
  });
}

function mapError(c: Ctx, err: unknown): void {
  if (err instanceof EvalApiError) {
    sendError(c, err.status, err.code, err.message, err.extra);
  } else if (err instanceof CatalogPathError) {
    c.json(c.res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
  } else if (err instanceof FileChangedError) {
    sendError(c, 409, "FILE_CHANGED", err.message, { current_hash: err.currentHash });
  } else if (err instanceof EvalsWriteError) {
    sendError(c, WRITE_ERROR_STATUS[err.code] ?? 500, err.code, err.message, err.findings.length > 0 ? { findings: err.findings } : {});
  } else if (err instanceof EvalRunError) {
    sendError(c, RUN_ERROR_STATUS[err.code] ?? 500, err.code, err.message, err.findings ? { findings: err.findings } : {});
  } else if (err instanceof EvalStoreError) {
    sendError(c, RUN_ERROR_STATUS[err.code] ?? 500, err.code, err.message);
  } else if (err instanceof CompareMismatchError) {
    sendError(c, 400, err.code, err.message);
  } else {
    sendError(c, 500, "internal_error", "Internal error");
  }
}

export function isEvalRoutePath(pathname: string): boolean {
  return (
    pathname === "/api/evals" ||
    pathname.startsWith("/api/evals/") ||
    pathname === "/api/datasets" ||
    pathname.startsWith("/api/datasets/") ||
    pathname === "/api/eval-runs" ||
    pathname.startsWith("/api/eval-runs/") ||
    pathname === "/api/eval-compare" ||
    pathname === "/api/eval-engine"
  );
}

export async function handleEvalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EvalRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const pathname = url.pathname;
  if (!isEvalRoutePath(pathname)) return false;
  if (pathname.startsWith("/api/evals/internal/")) return false;
  const seg = (value: string | undefined): string => decodeURIComponent(value ?? "");

  const manager = deps.evalRunManager;
  const c = { ...deps, req, res, url, method, pathname } as Ctx;

  if (method === "GET" && pathname === "/api/eval-engine") {
    handleEngine(c);
    return true;
  }

  const m = (re: RegExp): RegExpMatchArray | null => pathname.match(re);
  const run = async (fn: () => Promise<void> | void): Promise<boolean> => {
    if (manager === undefined) {
      sendError(c, 503, "EVAL_ENGINE_UNAVAILABLE", "Evals are not available on this Host");
      return true;
    }
    try {
      await fn();
    } catch (err) {
      mapError(c, err);
    }
    return true;
  };

  if (method === "GET" && pathname === "/api/evals") return run(() => handleEvalList(c));
  if (method === "POST" && pathname === "/api/evals") return run(() => handleEvalCreate(c));
  if (method === "POST" && pathname === "/api/evals/validate") return run(() => handleEvalValidate(c));
  if (method === "POST" && pathname === "/api/evals/sample") return run(() => handleSampleInstall(c));
  if (method === "POST" && pathname === "/api/evals/try") return run(() => handleTry(c));

  if (method === "POST" && pathname === "/api/evals/runs/estimate") return run(() => handleDraftEstimate(c));

  let match = m(/^\/api\/evals\/([^/]+)\/runs\/estimate$/);
  if (method === "GET" && match) return run(() => handleRunEstimate(c, seg(match![1])));
  match = m(/^\/api\/evals\/([^/]+)\/runs\/(\d+)$/);
  if (method === "GET" && match) return run(() => handleRunByNumber(c, seg(match![1]), Number(match![2])));
  match = m(/^\/api\/evals\/([^/]+)\/runs$/);
  if (method === "POST" && match) return run(() => handleRunStart(c, seg(match![1])));
  match = m(/^\/api\/evals\/([^/]+)\/failure-types$/);
  if (method === "GET" && match) return run(() => handleFailureTypes(c, seg(match![1])));
  match = m(/^\/api\/evals\/([^/]+)$/);
  if (match && method === "GET") return run(() => handleEvalGet(c, seg(match![1])));
  if (match && method === "PUT") return run(() => handleEvalUpdate(c, seg(match![1])));

  if (method === "GET" && pathname === "/api/datasets") return run(() => handleDatasetList(c));
  if (method === "POST" && pathname === "/api/datasets") return run(() => handleDatasetCreate(c));
  if (method === "POST" && pathname === "/api/datasets/preview") return run(() => handleDatasetPreview(c));
  if (method === "GET" && pathname === "/api/datasets/candidates") return run(() => handleCandidates(c));
  match = m(/^\/api\/datasets\/([^/]+)\/cases$/);
  if (method === "PATCH" && match) return run(() => handleDatasetPatch(c, seg(match![1])));
  match = m(/^\/api\/datasets\/([^/]+)\/convert$/);
  if (method === "POST" && match) return run(() => handleDatasetConvert(c, seg(match![1])));
  match = m(/^\/api\/datasets\/([^/]+)$/);
  if (method === "GET" && match) return run(() => handleDatasetGet(c, seg(match![1])));

  if (method === "GET" && pathname === "/api/eval-runs") return run(() => handleRunList(c));
  match = m(/^\/api\/eval-runs\/([^/]+)\/results\/([^/]+)\/(\d+)\/review$/);
  if (method === "PUT" && match) {
    return run(() => handleReviewPut(c, seg(match![1]), seg(match![2]), Number(match![3])));
  }
  match = m(/^\/api\/eval-runs\/([^/]+)\/results\/([^/]+)$/);
  if (method === "GET" && match) return run(() => handleResultDetail(c, seg(match![1]), seg(match![2])));
  match = m(/^\/api\/eval-runs\/([^/]+)\/results$/);
  if (method === "GET" && match) return run(() => handleResultsList(c, seg(match![1])));
  match = m(/^\/api\/eval-runs\/([^/]+)\/cancel$/);
  if (method === "POST" && match) return run(() => handleCancel(c, seg(match![1])));
  match = m(/^\/api\/eval-runs\/([^/]+)\/export$/);
  if (method === "GET" && match) return run(() => handleExport(c, seg(match![1])));
  match = m(/^\/api\/eval-runs\/([^/]+)$/);
  if (method === "GET" && match) return run(() => handleRunGet(c, seg(match![1])));
  if (method === "DELETE" && match) return run(() => handleDelete(c, seg(match![1])));

  if (method === "GET" && pathname === "/api/eval-compare") return run(() => handleCompare(c));
  return false;
}
