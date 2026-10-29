import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../../config/atomicWrite.js";
import {
  resolveDefaultWriteRoot,
  resolveCatalogStartInput,
} from "../../config/catalogRelativePath.js";
import { listDatasetFiles, loadEvalCatalog } from "../../config/evalCatalog.js";
import {
  resolveCatalogRoots,
  type CatalogRoot,
  type ResolveCatalogRootsOptions,
} from "../../config/resolveCatalogRoots.js";
import { loadDatasetFile } from "../../config/loadDataset.js";
import { evalStem, findDatasetFile, findEvalFile, manifestForWrite } from "../../config/evalWriteRoots.js";
import type { AgentCatalogPort } from "../../config/resolveAgentTarget.js";
import { resolveEvalTarget } from "../../config/resolveEvalTarget.js";
import { parseEvalOutcome, resolveEvalPaths, type LoadedEval } from "../../config/loadEval.js";
import type { ValidationFinding } from "../../config/validateCatalog.js";
import { evalFindingsFromIssues } from "../../config/validateEval.js";
import type { RunStore } from "../../runstore/port.js";
import { EVAL_RUN_STATUSES } from "../constants.js";
import type { EngineStatus } from "../engine/promptfoo/status.js";
import { PINNED_PROMPTFOO_VERSION } from "../engine/promptfoo/pinned.js";
import { buildEvalPlan } from "../plan.js";
import { liveAgentOf, type AgentWire } from "./agentTargets.js";
import { buildEvalListItems, costLastSevenDays, type EvalListItem } from "./list.js";
import { resultKey } from "../statsTypes.js";
import type { EvalRunRow } from "../storeTypes.js";
import { regressionBanner, type BannerEvalInput } from "../listStatus.js";
import { buildResultRows, RESULT_ROW_STATUSES, type ResultRowStatus } from "./results.js";
import { activeRunOf, completedRunsNewestFirst, resultToWire, runHeadline, type ActiveRun } from "./runs.js";
import { suggestionFor } from "./suggestions.js";

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
  active_run: ActiveRun | null;
  last_run: ReturnType<typeof runHeadline> | null;
  target_model: string | null;
  judge_default: string | null;
  agent?: AgentWire | null;
};

export async function buildEvalDetail(input: {
  store: RunStore;
  projectRoot: string;
  absPath: string;
  isKnownModel?: IsKnownModel;
  agents?: AgentCatalogPort;
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
  let targetModel: string | null = null;
  let agent: AgentWire | null | undefined;
  if (entry?.outcome.ok) {
    const file = entry.outcome.value.file;
    if (file.target.kind === "agent") {
      agent = await liveAgentOf(input.agents, projectRoot, file.target.agent);
      targetModel = file.defaults?.model ?? agent?.model ?? null;
    } else if (file.target.kind === "internal_agent") {
      targetModel = file.defaults?.model ?? null;
    } else {
      const target = await resolveEvalTarget(file, entry.outcome.value.path, projectRoot);
      if (target.ok) targetModel = target.value.modelResolved;
    }
  }
  return {
    id,
    path: rel(projectRoot, absPath),
    file_hash: contentHash(bytes),
    definition: entry?.outcome.ok ? entry.outcome.value.file : null,
    yaml: bytes.toString("utf8"),
    findings: entry?.findings ?? [],
    runs_count: runsCount,
    active_run: await activeRunOf(store, projectRoot, id),
    last_run: last ? runHeadline(last) : null,
    target_model: targetModel,
    judge_default: entry?.outcome.ok ? (entry.outcome.value.file.defaults?.judge ?? null) : null,
    ...(agent !== undefined ? { agent } : {}),
  };
}

export async function planFindings(input: {
  projectRoot: string;
  evalPath: string;
  evalText: string;
  datasetCases?: readonly unknown[];
  isKnownModel?: IsKnownModel;
  agents?: AgentCatalogPort;
  internalAgents?: ReadonlyArray<{ id: string; title: string; playbook: string; tools: string[] }>;
}): Promise<{ ok: boolean; findings: ValidationFinding[] }> {
  const built = await buildEvalPlan({
    projectRoot: input.projectRoot,
    evalPath: input.evalPath,
    evalText: input.evalText,
    ...(input.datasetCases !== undefined ? { datasetCases: input.datasetCases } : {}),
    evalRunId: "er_validate",
    engine: { name: ENGINE_NAME, version: PINNED_PROMPTFOO_VERSION, nodeVersion: process.versions.node },
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
    ...(input.agents ? { agents: input.agents } : {}),
    ...(input.internalAgents ? { internalAgents: input.internalAgents } : {}),
  });
  return { ok: built.ok, findings: built.findings };
}

export async function validateEvalText(input: {
  projectRoot: string;
  evalAbs: string;
  derived: string;
  datasetCases?: readonly unknown[];
  isKnownModel?: IsKnownModel;
  agents?: AgentCatalogPort;
  internalAgents?: ReadonlyArray<{ id: string; title: string; playbook: string; tools: string[] }>;
}) {
  const { projectRoot, evalAbs, derived } = input;
  const parsed = parseEvalOutcome(derived, evalAbs, projectRoot);
  const checked = await planFindings({
    projectRoot,
    evalPath: evalAbs,
    evalText: derived,
    ...(input.datasetCases !== undefined ? { datasetCases: input.datasetCases } : {}),
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
    ...(input.agents ? { agents: input.agents } : {}),
    ...(input.internalAgents ? { internalAgents: input.internalAgents } : {}),
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
    wireRootOf?: (projectRoot: string) => string;
    evalId?: string;
    status?: string;
    stageRunId?: string;
    subjectRef?: string;
    limit: number;
    cursor?: string;
  },
) {
  const { projectRoot, evalId, status, stageRunId, subjectRef, limit, cursor } = input;
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
      ...(subjectRef !== undefined ? { subjectRef } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
  } catch (err) {
    if (cursor !== undefined && err instanceof SyntaxError) throw badRequest("Invalid cursor", "invalid_cursor");
    throw err;
  }
  const items = await Promise.all(
    page.items.map(async (row) => {
      const headline = {
        ...runHeadline(row),
        created_at: row.createdAt,
        started_at: row.startedAt,
        results_total: row.resultsTotal,
        project_root: input.wireRootOf?.(row.projectRoot) ?? row.projectRoot,
      };
      if (stageRunId === undefined && subjectRef === undefined) return headline;
      const match = (await store.listEvalResults(row.evalRunId)).find((r) =>
        stageRunId !== undefined ? r.stageRunId === stageRunId : r.subjectRef === subjectRef,
      );
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
    targetKind: row.targetKind,
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
  const [cases, results, reviews, suggestions, graderLabels] = await Promise.all([
    store.getEvalCases(row.evalRunId),
    store.getEvalResultsForCase(row.evalRunId, caseId),
    store.getEvalReviews(row.evalRunId),
    store.listEvalSuggestions(row.evalRunId),
    store.listEvalGraderLabels(row.evalRunId),
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
      .map((r) => ({
        ...resultToWire(
          r,
          reviewByKey.get(resultKey(r.caseId, r.repeatIndex)),
          row.targetKind === "agent" ? (row.targetRef.agent_id ?? "") : undefined,
        ),
        suggestion: suggestionFor(suggestions, r.caseId, r.repeatIndex),
        grader_labels: Object.fromEntries(
          graderLabels
            .filter((l) => l.caseId === r.caseId && l.repeatIndex === r.repeatIndex)
            .map((l) => [l.graderId, { label: l.label, note: l.note }]),
        ),
      })),
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

export async function loadEvalListItems(input: {
  store: RunStore;
  projectRoot: string;
  wireRoot?: string;
  isKnownModel?: IsKnownModel;
  agents?: AgentCatalogPort;
}) {
  const { store, projectRoot } = input;
  const wireRoot = input.wireRoot ?? projectRoot;
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
  const built = await buildEvalListItems({
    store,
    projectRoot,
    entries,
    datasetCases: (abs) => counts.get(abs) ?? 0,
    ...(input.agents ? { agents: input.agents } : {}),
  });
  const items: EvalListItem[] = built.items.map((item) => ({ ...item, project_root: wireRoot }));
  return { items, banner: built.banner, bannerInputs: built.bannerInputs, manifest };
}

export type RootsOptions = ResolveCatalogRootsOptions;

export async function evalScopeRoots(options: RootsOptions, wire: string | undefined): Promise<CatalogRoot[]> {
  if (wire !== undefined) return [(await resolveCatalogStartInput(options, wire)).wireRoot];
  const roots = await resolveCatalogRoots(options);
  return roots.filter((r) => !r.read_only && r.available !== false);
}

export async function wireRootOf(options: RootsOptions): Promise<(projectRoot: string) => string> {
  const roots = await resolveCatalogRoots(options);
  return (projectRoot) => roots.find((r) => r.path === projectRoot)?.project_root ?? projectRoot;
}

export async function loadAggregatedEvalList(input: {
  options: RootsOptions;
  wire: string | undefined;
  now: Date;
  isKnownModel?: IsKnownModel;
  agents?: AgentCatalogPort;
}) {
  const roots = await evalScopeRoots(input.options, input.wire);
  const groups: Array<{ root: CatalogRoot; items: EvalListItem[] }> = [];
  const bannerInputs: BannerEvalInput[] = [];
  let datasets = 0;
  let cost = 0;
  for (const root of roots) {
    const loaded = await loadEvalListItems({
      store: input.options.store,
      projectRoot: root.path,
      wireRoot: root.project_root,
      ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
      ...(input.agents ? { agents: input.agents } : {}),
    });
    groups.push({ root, items: loaded.items });
    bannerInputs.push(...loaded.bannerInputs);
    datasets += (await listDatasetFiles(loaded.manifest)).length;
    cost += await costLastSevenDays(input.options.store, root.path, input.now);
  }
  return {
    groups,
    items: groups.flatMap((g) => g.items),
    banner: regressionBanner(bannerInputs),
    datasets,
    cost,
  };
}

function ambiguous(code: string, noun: string, id: string, roots: string[]): EvalApiError {
  return new EvalApiError(
    409,
    code,
    `${noun} "${id}" exists in more than one project; pass project_root`,
    { project_roots: roots },
  );
}

async function locate<T>(
  options: RootsOptions,
  wire: string | undefined,
  write: boolean,
  find: (projectRoot: string) => Promise<T | undefined>,
  fail: { ambiguousCode: string; notFoundCode: string; noun: string; id: string },
  missing: "throw" | "default",
): Promise<{ root: CatalogRoot; ref: T | undefined }> {
  const notFound = () => new EvalApiError(404, fail.notFoundCode, `${fail.noun} not found: ${fail.id}`);
  if (wire !== undefined) {
    const root = write
      ? (await resolveDefaultWriteRoot(options, wire)).wireRoot
      : (await resolveCatalogStartInput(options, wire)).wireRoot;
    const ref = await find(root.path);
    if (ref === undefined && missing === "throw") throw notFound();
    return { root, ref };
  }
  const matches: Array<{ root: CatalogRoot; ref: T }> = [];
  for (const root of await evalScopeRoots(options, undefined)) {
    const ref = await find(root.path);
    if (ref !== undefined) matches.push({ root, ref });
  }
  if (matches.length > 1) {
    throw ambiguous(fail.ambiguousCode, fail.noun, fail.id, matches.map((m) => m.root.project_root));
  }
  if (matches[0] !== undefined) return matches[0];
  if (missing === "throw") throw notFound();
  return { root: (await resolveDefaultWriteRoot(options)).wireRoot, ref: undefined };
}

export async function locateEval(options: RootsOptions, wire: string | undefined, id: string, write = false) {
  const { root, ref } = await locate(
    options,
    wire,
    write,
    (projectRoot) => findEvalFile(projectRoot, id),
    { ambiguousCode: "EVAL_AMBIGUOUS", notFoundCode: "EVAL_NOT_FOUND", noun: "Eval", id },
    "throw",
  );
  return { root, projectRoot: root.path, ref: ref as NonNullable<typeof ref> };
}

export async function locateEvalRoot(options: RootsOptions, wire: string | undefined, id: string) {
  const { root } = await locate(
    options,
    wire,
    false,
    (projectRoot) => findEvalFile(projectRoot, id),
    { ambiguousCode: "EVAL_AMBIGUOUS", notFoundCode: "EVAL_NOT_FOUND", noun: "Eval", id },
    "default",
  );
  return root;
}

export async function locateDataset(
  options: RootsOptions,
  wire: string | undefined,
  id: string,
  opts: { write: boolean; missing: "throw" | "default" },
) {
  const { root, ref } = await locate(
    options,
    wire,
    opts.write,
    (projectRoot) => findDatasetFile(projectRoot, id),
    { ambiguousCode: "DATASET_AMBIGUOUS", notFoundCode: "DATASET_NOT_FOUND", noun: "Dataset", id },
    opts.missing,
  );
  return { root, projectRoot: root.path, ref };
}
