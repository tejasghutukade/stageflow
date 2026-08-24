import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { loadTaskFromYaml } from "../../config/loadTask.js";
import { derivePendingPrompt } from "../../hitl/qaTrail.js";
import type { StageEnvelope } from "../../types/envelope.js";
import {
  stageStatusFromEvents,
  type RunDetail,
  type RunMeta,
  type RunSummary,
  type StageLogEvent,
  type StageSnapshot,
} from "../port.js";
import { projectRunDetail, projectRunSummary, orderStageSnapshots } from "../runProjection.js";
import { buildStageSnapshotFromStore } from "../stageSnapshot.js";
import {
  envelopePath,
  listArtifactNames,
  stageLogPath,
} from "../workspaceLayout.js";

export { listArtifactNames };

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readStageLogFromDisk(
  workspaceDir: string,
  stageId: string,
): Promise<StageLogEvent[]> {
  const file = stageLogPath(workspaceDir, stageId);
  if (!(await fileExists(file))) return [];
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StageLogEvent);
}

export async function loadStageSnapshotFromDisk(
  workspaceDir: string,
  stageId: string,
  store?: import("../port.js").RunStore,
  runId?: string,
): Promise<StageSnapshot> {
  if (store !== undefined && runId !== undefined) {
    return buildStageSnapshotFromStore(store, runId, stageId, workspaceDir);
  }

  const events = await readStageLogFromDisk(workspaceDir, stageId);
  const envFile = envelopePath(workspaceDir, stageId);
  let envelope: StageEnvelope | null = null;
  if (await fileExists(envFile)) {
    envelope = JSON.parse(await readFile(envFile, "utf8")) as StageEnvelope;
  }
  const artifacts = await listArtifactNames(workspaceDir, stageId, 1);
  const last_at = events.length > 0 ? events[events.length - 1]?.at : undefined;
  const pending = derivePendingPrompt(events);
  return {
    stage_id: stageId,
    status: stageStatusFromEvents(events),
    events,
    envelope,
    artifacts,
    last_at,
    attempt_count: 1,
    ...(pending ? { pending_prompt: pending } : {}),
  };
}

export async function listStageIdsFromDisk(
  workspaceDir: string,
  meta?: RunMeta,
): Promise<string[]> {
  if (meta?.pipeline_dag?.stage_ids?.length) {
    return [...meta.pipeline_dag.stage_ids];
  }
  const stagesPath = path.join(workspaceDir, "stages");
  if (!(await fileExists(stagesPath))) return [];
  const entries = await readdir(stagesPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function taskIdFromCopy(
  workspaceDir: string,
  meta: RunMeta,
): Promise<string | undefined> {
  if (meta.task_id) return meta.task_id;
  const taskPath = path.join(workspaceDir, "task.copy.yaml");
  if (!(await fileExists(taskPath))) return undefined;
  try {
    const task = loadTaskFromYaml(await readFile(taskPath, "utf8"), "task.copy.yaml");
    return task.id;
  } catch {
    return undefined;
  }
}

export async function readRunMetaFromDisk(workspaceDir: string): Promise<RunMeta> {
  const file = path.join(workspaceDir, "meta.json");
  return JSON.parse(await readFile(file, "utf8")) as RunMeta;
}

export async function buildRunSummaryFromDisk(
  workspaceDir: string,
): Promise<RunSummary> {
  const meta = await readRunMetaFromDisk(workspaceDir);
  const stageIds = await listStageIdsFromDisk(workspaceDir, meta);
  const loaded = await Promise.all(
    stageIds.map((id) => loadStageSnapshotFromDisk(workspaceDir, id)),
  );
  const stages = meta.pipeline_dag?.stage_ids?.length
    ? orderStageSnapshots(meta.pipeline_dag.stage_ids, loaded)
    : loaded;
  const task_id = await taskIdFromCopy(workspaceDir, meta);
  return projectRunSummary({ ...meta, task_id }, stages);
}

export async function buildRunDetailFromDisk(workspaceDir: string): Promise<RunDetail> {
  const meta = await readRunMetaFromDisk(workspaceDir);
  const task_yaml = await readFile(path.join(workspaceDir, "task.copy.yaml"), "utf8");
  const stageIds = await listStageIdsFromDisk(workspaceDir, meta);
  const loaded = await Promise.all(
    stageIds.map((id) => loadStageSnapshotFromDisk(workspaceDir, id)),
  );
  const stages = meta.pipeline_dag?.stage_ids?.length
    ? orderStageSnapshots(meta.pipeline_dag.stage_ids, loaded)
    : loaded;
  const task_id = await taskIdFromCopy(workspaceDir, meta);
  return projectRunDetail(
    { ...meta, task_id },
    stages,
    task_yaml,
    meta.pipeline_dag ?? null,
  );
}
