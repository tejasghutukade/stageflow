import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../../config/atomicWrite.js";
import { loadEvalCatalog } from "../../config/evalCatalog.js";
import { loadDatasetFile } from "../../config/loadDataset.js";
import { evalStem, findEvalFile, manifestForWrite } from "../../config/evalWriteRoots.js";
import { parseEvalOutcome, resolveEvalPaths, type LoadedEval } from "../../config/loadEval.js";
import type { ValidationFinding } from "../../config/validateCatalog.js";
import { evalFindingsFromIssues } from "../../config/validateEval.js";
import type { RunStore } from "../../runstore/port.js";
import { EVAL_RUN_STATUSES } from "../constants.js";
import type { EngineStatus } from "../engine/promptfoo/status.js";
import { PINNED_PROMPTFOO_VERSION } from "../engine/promptfoo/pinned.js";
import { buildEvalPlan } from "../plan.js";
import { buildEvalListItems } from "./list.js";
import { resultKey } from "../statsTypes.js";
import type { EvalRunRow } from "../storeTypes.js";
import { buildResultRows, RESULT_ROW_STATUSES, type ResultRowStatus } from "./results.js";
import { completedRunsNewestFirst, resultToWire, runHeadline } from "./runs.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const ENGINE_NAME = "promptfoo";

export class EvalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EvalApiError";
  }
}

export type IsKnownModel = (id: string) => Promise<boolean>;

export function rel(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

export function badRequest(message: string, code = "invalid_request"): EvalApiError {
  return new EvalApiError(400, code, message);
}

export function engineCheck(status: EngineStatus): void {
  if (!status.nodeOk) {
    throw new EvalApiError(503, "EVAL_NODE_TOO_OLD", `Evals need a newer Node.js; found ${status.node}`);
  }
  if (!status.installed) {
    throw new EvalApiError(
      503,
      "EVAL_ENGINE_UNAVAILABLE",
      `The eval engine is not installed. Run \`${status.installCommand}\`.`,
    );
  }
}

export async function findEvalOr404(projectRoot: string, id: string) {
  const ref = await findEvalFile(projectRoot, id);
  if (ref === undefined) throw new EvalApiError(404, "EVAL_NOT_FOUND", `Eval not found: ${id}`);
  return ref;
}

export async function runByIdOr404(store: RunStore, id: string): Promise<EvalRunRow> {
  const row = await store.getEvalRun(id);
  if (row === null) throw new EvalApiError(404, "EVAL_RUN_NOT_FOUND", `Eval run not found: ${id}`);
  return row;
}

export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffset(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) return parsed.offset;
  } catch {
    // fall through to the error below
  }
  throw badRequest("Invalid cursor", "invalid_cursor");
}

export type EvalDetailWire = {
  id: string;
  path: string;
  file_hash: string;
  definition: unknown;
  yaml: string;
  findings: ValidationFinding[];
  runs_count: number;
  last_run: ReturnType<typeof runHeadline> | null;
};

export async function buildEvalDetail(input: {
  store: RunStore;
  projectRoot: string;
  absPath: string;
  isKnownModel?: IsKnownModel;
}): Promise<EvalDetailWire> {
  const { store, projectRoot, absPath } = input;
  const manifest = await manifestForWrite(projectRoot);
  const entries = await loadEvalCatalog(manifest, input.isKnownModel ? { isKnownModel: input.isKnownModel } : {});
  const entry = entries.find((e) => path.resolve(e.absPath) === path.resolve(absPath));
  const bytes = await readFile(absPath);
  const id = entry?.outcome.ok ? entry.outcome.value.id : evalStem(path.basename(absPath));
  let runsCount = 0;
  let cursor: string | undefined;
  do {
    const page = await store.listEvalRuns({ projectRoot, evalId: id, limit: MAX_LIMIT, ...(cursor ? { cursor } : {}) });
    runsCount += page.items.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const last = (await completedRunsNewestFirst(store, projectRoot, id, 1))[0];
  return {
    id,
    path: rel(projectRoot, absPath),
    file_hash: contentHash(bytes),
    definition: entry?.outcome.ok ? entry.outcome.value.file : null,
    yaml: bytes.toString("utf8"),
    findings: entry?.findings ?? [],
    runs_count: runsCount,
    last_run: last ? runHeadline(last) : null,
  };
}

export async function planFindings(input: {
  projectRoot: string;
  evalPath: string;
  evalText: string;
  isKnownModel?: IsKnownModel;
}): Promise<{ ok: boolean; findings: ValidationFinding[] }> {
  const built = await buildEvalPlan({
    projectRoot: input.projectRoot,
    evalPath: input.evalPath,
    evalText: input.evalText,
    evalRunId: "er_validate",
    engine: { name: ENGINE_NAME, version: PINNED_PROMPTFOO_VERSION, nodeVersion: process.versions.node },
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
  });
  return { ok: built.ok, findings: built.findings };
}

export async function validateEvalText(input: {
  projectRoot: string;
  evalAbs: string;
  derived: string;
  isKnownModel?: IsKnownModel;
}) {
  const { projectRoot, evalAbs, derived } = input;
  const parsed = parseEvalOutcome(derived, evalAbs, projectRoot);
  const checked = await planFindings({
    projectRoot,
    evalPath: evalAbs,
    evalText: derived,
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
  });
  const findings =
    checked.findings.length > 0 || parsed.ok
      ? checked.findings
      : evalFindingsFromIssues(rel(projectRoot, evalAbs), parsed.issues);
  return { findings, parsed };
}

export async function listEvalRunsPage(
  store: RunStore,
  input: {
    projectRoot?: string;
    evalId?: string;
    status?: string;
    stageRunId?: string;
    limit: number;
    cursor?: string;
  },
) {
  const { projectRoot, evalId, status, stageRunId, limit, cursor } = input;
  if (status !== undefined && !(EVAL_RUN_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`"status" must be one of ${EVAL_RUN_STATUSES.join(", ")}`);
  }
  let page;
  try {
    page = await store.listEvalRuns({
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(evalId !== undefined ? { evalId } : {}),
      ...(status !== undefined ? { status: status as (typeof EVAL_RUN_STATUSES)[number] } : {}),
      ...(stageRunId !== undefined ? { stageRunId } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  } catch (err) {
    if (cursor !== undefined && err instanceof SyntaxError) throw badRequest("Invalid cursor", "invalid_cursor");
    throw err;
  }
  const items = await Promise.all(
    page.items.map(async (row) => {
      const headline = runHeadline(row);
      if (stageRunId === undefined) return headline;
      const match = (await store.listEvalResults(row.evalRunId)).find((r) => r.stageRunId === stageRunId);
      return {
        ...headline,
        ...(match ? { result: { case_id: match.caseId, repeat_index: match.repeatIndex } } : {}),
      };
    }),
  );
  return { items, next_cursor: page.nextCursor };
}

export async function buildResultsPage(
  store: RunStore,
  id: string,
  input: { status?: string; grader?: string; q?: string; tag?: string; limit: number; cursor?: string | null },
) {
  const row = await runByIdOr404(store, id);
  const { status, grader, q, tag, limit } = input;
  if (status !== undefined && !(RESULT_ROW_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`"status" must be one of ${RESULT_ROW_STATUSES.join(", ")}`);
  }
  const offset = decodeOffset(input.cursor);
  const [cases, results, reviews] = await Promise.all([
    store.getEvalCases(row.evalRunId),
    store.listEvalResults(row.evalRunId),
    store.getEvalReviews(row.evalRunId),
  ]);
  const { rows, counts } = buildResultRows({
    cases,
    results,
    reviews,
    filter: {
      ...(status !== undefined ? { status: status as ResultRowStatus } : {}),
      ...(grader !== undefined ? { grader } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(tag !== undefined ? { tag } : {}),
    },
  });
  const page = rows.slice(offset, offset + limit);
  return {
    items: page,
    next_cursor: offset + limit < rows.length ? encodeOffset(offset + limit) : null,
    counts,
  };
}

export async function buildResultDetail(store: RunStore, id: string, caseId: string) {
  const row = await runByIdOr404(store, id);
  const [cases, results, reviews] = await Promise.all([
    store.getEvalCases(row.evalRunId),
    store.getEvalResultsForCase(row.evalRunId, caseId),
    store.getEvalReviews(row.evalRunId),
  ]);
  const caseRow = cases.find((x) => x.caseId === caseId);
  if (!caseRow || results.length === 0) {
    throw new EvalApiError(404, "EVAL_RUN_NOT_FOUND", `Eval result not found: ${id}/${caseId}`);
  }
  const reviewByKey = new Map(reviews.map((r) => [resultKey(r.caseId, r.repeatIndex), r]));
  return {
    case: { ...caseRow.case, position: caseRow.position },
    repeats: [...results]
      .sort((a, b) => a.repeatIndex - b.repeatIndex)
      .map((r) => resultToWire(r, reviewByKey.get(resultKey(r.caseId, r.repeatIndex)))),
  };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

export async function loadEvalListItems(input: { store: RunStore; projectRoot: string; isKnownModel?: IsKnownModel }) {
  const { store, projectRoot } = input;
  const manifest = await manifestForWrite(projectRoot);
  const counts = new Map<string, number>();
  const entries = await loadEvalCatalog(manifest, {
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
    datasetReportFor: async (loaded: LoadedEval) => {
      const { datasetPath } = resolveEvalPaths(loaded.file, loaded.path);
      if (!(await exists(datasetPath))) return undefined;
      const report = await loadDatasetFile(datasetPath, { root: projectRoot });
      counts.set(datasetPath, report.cases.length);
      return report;
    },
  });
  const { items, banner } = await buildEvalListItems({
    store,
    projectRoot,
    entries,
    datasetCases: (abs) => counts.get(abs) ?? 0,
  });
  return { items, banner, manifest };
}
