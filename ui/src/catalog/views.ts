import type { CapacityHealth, PipelineListing, RunSummary } from "../api";
import type { CatalogSnapshot } from "./source";
import { matchPipelineRun } from "./displayCatalogPath.js";

export type CatalogBuckets = {
  waiting: RunSummary[];
  inFlight: RunSummary[];
  broken: RunSummary[];
  finished: RunSummary[];
};

export type CapacityView = {
  line: string;
  health: CapacityHealth | null;
  inFlight: number;
  broken: number;
};

export function bucketViews(snapshot: CatalogSnapshot): CatalogBuckets {
  const waiting: RunSummary[] = [];
  const inFlight: RunSummary[] = [];
  const broken: RunSummary[] = [];
  const finished: RunSummary[] = [];

  for (const run of snapshot.runs) {
    if (run.waiting_stage_id) {
      waiting.push(run);
    } else if (run.status === "failed") {
      broken.push(run);
    } else if (run.status === "succeeded") {
      finished.push(run);
    } else if (run.status === "running" || run.status === "created") {
      inFlight.push(run);
    }
  }

  return { waiting, inFlight, broken, finished };
}

export function waitingView(snapshot: CatalogSnapshot): RunSummary[] {
  return bucketViews(snapshot).waiting;
}

export function inFlightView(snapshot: CatalogSnapshot): RunSummary[] {
  return bucketViews(snapshot).inFlight;
}

export function brokenView(snapshot: CatalogSnapshot): RunSummary[] {
  return bucketViews(snapshot).broken;
}

export function finishedView(snapshot: CatalogSnapshot): RunSummary[] {
  return bucketViews(snapshot).finished;
}

function capacityLine(
  inFlight: number,
  broken: number,
  health: CapacityHealth | null,
): string {
  const buckets = `${inFlight} in flight · ${broken} failed`;
  if (!health) return buckets;
  if (health.slotsAvailable === 0) {
    return `${buckets} · no free session slots`;
  }
  const slotWord = health.slotsAvailable === 1 ? "slot" : "slots";
  return `${buckets} · ${health.slotsAvailable} free ${slotWord} · ${health.activeCount}/${health.maxConcurrent} in use`;
}

export function capacityView(snapshot: CatalogSnapshot): CapacityView {
  const buckets = bucketViews(snapshot);
  return {
    line: capacityLine(buckets.inFlight.length, buckets.broken.length, snapshot.health),
    health: snapshot.health,
    inFlight: buckets.inFlight.length,
    broken: buckets.broken.length,
  };
}

function sortRunsNewest(runs: RunSummary[]): RunSummary[] {
  return runs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function runsForTaskView(
  snapshot: CatalogSnapshot,
  taskId: string,
): RunSummary[] {
  return sortRunsNewest(snapshot.runs.filter((run) => run.task_id === taskId));
}

export function runsForPipelineView(
  snapshot: CatalogSnapshot,
  pipeline: PipelineListing | string,
): RunSummary[] {
  return sortRunsNewest(
    snapshot.runs.filter((run) =>
      typeof pipeline === "string"
        ? run.pipeline_id === pipeline
        : matchPipelineRun(run, pipeline),
    ),
  );
}

export type RunsFilterCounts = {
  all: number;
  waiting: number;
  running: number;
  failed: number;
  finished: number;
};

export function runsFilterCounts(snapshot: CatalogSnapshot): RunsFilterCounts {
  const buckets = bucketViews(snapshot);
  return {
    all: snapshot.runs.length,
    waiting: buckets.waiting.length,
    running: buckets.inFlight.length,
    failed: buckets.broken.length,
    finished: buckets.finished.length,
  };
}

export function waitingRunsAmongView(
  snapshot: CatalogSnapshot,
  ids: string[],
): RunSummary[] {
  const byId = new Map(snapshot.runs.map((run) => [run.run_id, run]));
  return ids.flatMap((id) => {
    const run = byId.get(id);
    return run?.waiting_stage_id ? [run] : [];
  });
}
