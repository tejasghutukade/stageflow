import path from "node:path";
import type { EvalCatalogEntry } from "../../config/evalCatalog.js";
import { EVAL_DEFAULT_REPEATS, resolveConversation, resolveEvalPaths } from "../../config/loadEval.js";
import type { AgentCatalogPort } from "../../config/resolveAgentTarget.js";
import { evalStem } from "../../config/evalWriteRoots.js";
import {
  listStatus,
  regressionBanner,
  type BannerEvalInput,
  type ListRunSummary,
  type ListStatus,
  type RegressionBanner,
} from "../listStatus.js";
import type { EvalRunRow } from "../storeTypes.js";
import {
  activeRunOf,
  completedRunsNewestFirst,
  type ActiveRun,
  runHeadline,
  statsOfRun,
  type ReadStore,
  type RunHeadline,
} from "./runs.js";

export type EvalListTarget =
  | {
      kind: "stage";
      pipeline_path?: string;
      stage_id?: string;
      file?: string;
      label: string;
    }
  | {
      kind: "agent";
      agent_id: string;
      agent_name: string;
      model: string | null;
      revision: number | null;
      label: string;
    };

export type EvalListItem = {
  project_root?: string;
  id: string;
  name: string;
  description: string | null;
  type: string;
  path: string;
  target: EvalListTarget;
  conversation?: { mode: string; max_turns: number; tools: string; approvals: string };
  dataset_path: string;
  dataset_cases: number;
  repeats: number;
  grader_count: number;
  rubric_count: number;
  valid: boolean;
  finding_count: number;
  status: ListStatus | "running";
  active_run: ActiveRun | null;
  last_run: RunHeadline | null;
  last_run_delta_pts: number | null;
  trend: Array<{ run_number: number; passed: boolean; pass_rate: number | null; pass_threshold: number }>;
};

const TREND_RUNS = 7;

function posix(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

function pipelineStem(pipelinePath: string): string {
  return path.basename(pipelinePath).replace(/\.pipeline\.ya?ml$/, "");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

async function agentListTarget(
  agentId: string,
  last: EvalRunRow | undefined,
  agents: AgentCatalogPort | undefined,
  projectRoot: string,
): Promise<Extract<EvalListTarget, { kind: "agent" }>> {
  const snap = last && last.targetKind === "agent" ? (last.config as { target?: Record<string, unknown> }).target : undefined;
  let name: string | null = null;
  let model: string | null = null;
  let revision: number | null = null;
  if (snap) {
    const def = (snap.definition ?? {}) as { name?: unknown };
    name = str(def.name);
    model = str(snap.model);
    revision = typeof snap.revision === "number" ? snap.revision : null;
  } else if (agents) {
    try {
      const detail = await agents.get(projectRoot, agentId);
      name = str(detail.agent.name);
      model = str(detail.agent.model?.id);
      revision = detail.agent.revision;
    } catch {
      // the agent may be deleted or unreadable: fall back to the id
    }
  }
  const agentName = name ?? agentId;
  return { kind: "agent", agent_id: agentId, agent_name: agentName, model, revision, label: agentName };
}

export function filterEvalListItems(
  items: readonly EvalListItem[],
  filter: { target_kind?: string | null; agent?: string | null },
): EvalListItem[] {
  return items.filter((item) => {
    if (filter.target_kind && item.target.kind !== filter.target_kind) return false;
    if (filter.agent && !(item.target.kind === "agent" && item.target.agent_id === filter.agent)) return false;
    return true;
  });
}

async function listRunSummary(store: ReadStore, row: EvalRunRow): Promise<ListRunSummary> {
  const stats = statsOfRun(row, await store.listEvalResults(row.evalRunId));
  return {
    runNumber: row.runNumber,
    passed: row.passed === true,
    passRate: stats.pass_rate,
    finishedAt: row.finishedAt,
    graders: stats.by_grader.map((g) => ({ graderId: g.grader_id, hash: g.hash, passRate: g.pass_rate })),
  };
}

export async function buildEvalListItems(input: {
  store: ReadStore;
  projectRoot: string;
  entries: readonly EvalCatalogEntry[];
  datasetCases: (absPath: string) => number;
  agents?: AgentCatalogPort;
}): Promise<{ items: EvalListItem[]; banner: RegressionBanner | null; bannerInputs: BannerEvalInput[] }> {
  const { store, projectRoot } = input;
  const items: EvalListItem[] = [];
  const bannerInputs: BannerEvalInput[] = [];

  for (const entry of input.entries) {
    const findingCount = entry.findings.length;
    const valid = !entry.findings.some((f) => f.severity === "error");
    if (!entry.outcome.ok) {
      const id = evalStem(path.basename(entry.absPath));
      items.push({
        id,
        name: id,
        description: null,
        type: "capability",
        path: entry.relPath,
        target: { kind: "stage", label: "Unknown target" },
        dataset_path: "",
        dataset_cases: 0,
        repeats: EVAL_DEFAULT_REPEATS,
        grader_count: 0,
        rubric_count: 0,
        valid: false,
        finding_count: findingCount,
        status: "never_run",
        active_run: null,
        last_run: null,
        last_run_delta_pts: null,
        trend: [],
      });
      continue;
    }

    const loaded = entry.outcome.value;
    const { file } = loaded;
    const paths = resolveEvalPaths(file, loaded.path);
    const type = file.type ?? "capability";
    const stageId = file.target.kind === "stage" ? file.target.stage : undefined;
    const completed = await completedRunsNewestFirst(store, projectRoot, loaded.id);
    const last = completed[0];
    const previous = completed[1];
    const lastSummary = last ? await listRunSummary(store, last) : null;
    const previousSummary = previous ? await listRunSummary(store, previous) : null;
    const status = listStatus(
      [lastSummary, previousSummary].filter((s): s is ListRunSummary => s !== null),
      type,
    );
    const activeRun = await activeRunOf(store, projectRoot, loaded.id);
    bannerInputs.push({ evalId: loaded.id, status, last: lastSummary, previous: previousSummary });

    const agentTarget =
      file.target.kind === "agent"
        ? await agentListTarget(file.target.agent, last, input.agents, projectRoot)
        : file.target.kind === "internal_agent"
          ? {
              kind: "agent" as const,
              agent_id: file.target.profile,
              agent_name: file.target.profile,
              model: file.defaults?.model ?? null,
              revision: null,
              label: `${file.target.profile} (internal)`,
            }
          : undefined;
    const conv = agentTarget ? resolveConversation(file.conversation) : undefined;

    const pipelinePath = paths.pipelinePath !== undefined ? posix(projectRoot, paths.pipelinePath) : undefined;
    const stageFile = paths.stageFile !== undefined ? posix(projectRoot, paths.stageFile) : undefined;
    const label =
      pipelinePath !== undefined
        ? `${pipelineStem(pipelinePath)} · ${stageId ?? ""}`
        : path.basename(stageFile ?? "").replace(/\.(stage\.)?ya?ml$/, "");
    const delta =
      lastSummary?.passRate != null && previousSummary?.passRate != null
        ? (lastSummary.passRate - previousSummary.passRate) * 100
        : null;

    items.push({
      id: loaded.id,
      name: file.name ?? loaded.id,
      description: file.description ?? null,
      type,
      path: entry.relPath,
      target: agentTarget ?? {
        kind: "stage",
        ...(pipelinePath !== undefined ? { pipeline_path: pipelinePath } : {}),
        ...(stageId !== undefined ? { stage_id: stageId } : {}),
        ...(stageFile !== undefined ? { file: stageFile } : {}),
        label,
      },
      ...(conv
        ? { conversation: { mode: conv.mode, max_turns: conv.maxTurns, tools: conv.tools, approvals: conv.approvals } }
        : {}),
      dataset_path: posix(projectRoot, paths.datasetPath),
      dataset_cases: input.datasetCases(paths.datasetPath),
      repeats: file.defaults?.repeats ?? EVAL_DEFAULT_REPEATS,
      grader_count: loaded.graders.length,
      rubric_count: loaded.graders.filter((g) => g.type === "rubric").length,
      valid,
      finding_count: findingCount,
      status: activeRun ? "running" : status,
      active_run: activeRun,
      last_run: last ? runHeadline(last) : null,
      last_run_delta_pts: delta,
      trend: completed
        .slice(0, TREND_RUNS)
        .reverse()
        .map((r) => ({
          run_number: r.runNumber,
          passed: r.passed === true,
          pass_rate: ((r.summary ?? {}) as { pass_rate?: number | null }).pass_rate ?? null,
          pass_threshold: r.passThreshold,
        })),
    });
  }
  return { items, banner: regressionBanner(bannerInputs), bannerInputs };
}

export async function costLastSevenDays(
  store: Pick<ReadStore, "listEvalRuns">,
  projectRoot: string,
  now: Date,
): Promise<number> {
  const cutoff = now.getTime() - 7 * 24 * 3600 * 1000;
  const createdFloor = cutoff - 24 * 3600 * 1000;
  let total = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await store.listEvalRuns({ projectRoot, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const run of page.items) {
      if (run.finishedAt !== null && Date.parse(run.finishedAt) >= cutoff) total += run.costUsd;
    }
    const oldest = page.items[page.items.length - 1];
    if (page.nextCursor === null || !oldest || Date.parse(oldest.createdAt) < createdFloor) break;
    cursor = page.nextCursor;
  }
  return total;
}
