import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RunMeta, RunStore } from "../runstore/port.js";
import { EvalsWriteError } from "./atomicWrite.js";
import type { NewDatasetCase } from "./writeDataset.js";

export type CandidateTarget = { stageId: string; pipelinePath?: string };

export type DatasetCandidate = { runId: string; finishedAt: string; preview: string };

const PREVIEW_CHARS = 160;
const SHORT_ID_CHARS = 8;

export function standalonePipelineId(stageId: string): string {
  return `standalone-${stageId}`;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCandidateRun(meta: RunMeta, target: CandidateTarget): boolean {
  if (meta.origin === "eval" || meta.status !== "succeeded") return false;
  if (meta.pipeline_id === standalonePipelineId(target.stageId)) return true;
  if (target.pipelinePath === undefined || meta.pipeline_path === undefined) return false;
  if (path.resolve(meta.pipeline_path) !== path.resolve(target.pipelinePath)) return false;
  return meta.pipeline_dag?.roots.includes(target.stageId) ?? false;
}

async function recordedInput(store: RunStore, runId: string): Promise<Record<string, unknown> | undefined> {
  const detail = await store.readRun(runId);
  let task: unknown;
  try {
    task = parseYaml(detail.task_yaml);
  } catch {
    return undefined;
  }
  if (!isPlain(task) || !isPlain(task.input)) return undefined;
  return task.input;
}

export async function listDatasetCandidates(input: {
  store: RunStore;
  target: CandidateTarget;
  limit: number;
}): Promise<DatasetCandidate[]> {
  const { store, target, limit } = input;
  const pipelines = [standalonePipelineId(target.stageId)];
  if (target.pipelinePath !== undefined) pipelines.push(target.pipelinePath);

  const summaries = (
    await Promise.all(pipelines.map((pipeline) => store.listRuns({ pipeline, status: "succeeded" })))
  ).flat();
  const seen = new Set<string>();
  const ordered = summaries
    .filter((s) => (seen.has(s.run_id) ? false : (seen.add(s.run_id), true)))
    .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at));

  const items: DatasetCandidate[] = [];
  for (const summary of ordered) {
    if (items.length >= limit) break;
    const meta = await store.readRunMeta(summary.run_id);
    if (!isCandidateRun(meta, target)) continue;
    const recorded = await recordedInput(store, summary.run_id);
    if (recorded === undefined) continue;
    items.push({
      runId: summary.run_id,
      finishedAt: summary.finished_at ?? summary.created_at,
      preview: JSON.stringify(recorded).slice(0, PREVIEW_CHARS),
    });
  }
  return items;
}

export async function casesFromRuns(input: {
  store: RunStore;
  runIds: readonly string[];
  target: CandidateTarget;
}): Promise<NewDatasetCase[]> {
  const { store, target } = input;
  const cases: NewDatasetCase[] = [];
  for (const runId of input.runIds) {
    let meta: RunMeta;
    try {
      meta = await store.readRunMeta(runId);
    } catch {
      throw new EvalsWriteError("DATASET_CASE_OP_INVALID", `run ${runId} not found`);
    }
    const recorded = isCandidateRun(meta, target) ? await recordedInput(store, runId) : undefined;
    if (recorded === undefined) {
      throw new EvalsWriteError(
        "DATASET_CASE_OP_INVALID",
        `run ${runId} is not a completed run of stage "${target.stageId}" with a recorded input`,
      );
    }
    cases.push({
      title: `Run ${runId.slice(0, SHORT_ID_CHARS)}`,
      input: recorded,
      metadata: { source_run: runId },
    });
  }
  return cases;
}
