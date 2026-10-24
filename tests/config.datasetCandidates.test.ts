import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { casesFromRuns, listDatasetCandidates } from "../src/config/datasetCandidates.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import type { RunStatus, RunStore } from "../src/runstore/port.js";

const PIPELINE = "/proj/pipelines/review.pipeline.yaml";

async function openStore(): Promise<RunStore> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-cand-store-"));
  return createRunStore({ rootDir: root, kind: "sqlite" });
}

function task(input: unknown): string {
  return stringify({ id: "t", goal: "g", ...(input === undefined ? {} : { input }) });
}

async function addRun(
  store: RunStore,
  opts: {
    pipelineId: string;
    pipelinePath?: string;
    stages?: string[];
    input?: unknown;
    origin?: "eval";
    status?: RunStatus;
  },
): Promise<string> {
  const created = await store.createRun({
    pipelineId: opts.pipelineId,
    taskYaml: task(opts.input),
    ...(opts.pipelinePath !== undefined ? { pipelinePath: opts.pipelinePath } : {}),
    ...(opts.stages !== undefined ? { pipelineDag: linearCompatDagSnapshot(opts.stages) } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  });
  await store.updateRunStatus(created.runId, opts.status ?? "succeeded");
  return created.runId;
}

describe("listDatasetCandidates", () => {
  it("lists standalone runs and entry-stage pipeline runs; skips eval runs, other stages and unfinished runs", async () => {
    const store = await openStore();
    const standalone = await addRun(store, { pipelineId: "standalone-review", input: { diff: "a" } });
    const entry = await addRun(store, {
      pipelineId: "review",
      pipelinePath: PIPELINE,
      stages: ["review", "ship"],
      input: { diff: "b" },
    });
    await addRun(store, { pipelineId: "standalone-review", input: { diff: "e" }, origin: "eval" });
    await addRun(store, {
      pipelineId: "review",
      pipelinePath: PIPELINE,
      stages: ["review", "ship"],
      input: { diff: "e2" },
      origin: "eval",
    });
    await addRun(store, { pipelineId: "standalone-other", input: { diff: "c" } });
    await addRun(store, {
      pipelineId: "review",
      pipelinePath: PIPELINE,
      stages: ["plan", "review"],
      input: { diff: "d" },
    });
    await addRun(store, { pipelineId: "standalone-review", input: { diff: "f" }, status: "failed" });
    await addRun(store, { pipelineId: "standalone-review" });

    const items = await listDatasetCandidates({
      store,
      target: { stageId: "review", pipelinePath: PIPELINE },
      limit: 50,
    });
    expect(items.map((i) => i.runId).sort()).toEqual([standalone, entry].sort());
    const byRun = new Map(items.map((i) => [i.runId, i]));
    expect(byRun.get(standalone)!.preview).toBe('{"diff":"a"}');
    expect(byRun.get(entry)!.preview).toBe('{"diff":"b"}');
    expect(typeof byRun.get(entry)!.finishedAt).toBe("string");
  });

  it("without a pipeline path only standalone runs of the stage appear", async () => {
    const store = await openStore();
    const standalone = await addRun(store, { pipelineId: "standalone-review", input: { diff: "a" } });
    await addRun(store, { pipelineId: "review", pipelinePath: PIPELINE, stages: ["review"], input: { diff: "b" } });
    const items = await listDatasetCandidates({ store, target: { stageId: "review" }, limit: 50 });
    expect(items.map((i) => i.runId)).toEqual([standalone]);
  });

  it("truncates the preview to 160 characters and honors the limit", async () => {
    const store = await openStore();
    for (let i = 0; i < 3; i += 1) {
      await addRun(store, { pipelineId: "standalone-review", input: { diff: "x".repeat(500) } });
    }
    const items = await listDatasetCandidates({ store, target: { stageId: "review" }, limit: 2 });
    expect(items).toHaveLength(2);
    expect(items[0]!.preview).toHaveLength(160);
    expect(items[0]!.preview.startsWith('{"diff":"xxx')).toBe(true);
  });
});

describe("casesFromRuns", () => {
  it("builds cases from the recorded input with a title and source run", async () => {
    const store = await openStore();
    const runId = await addRun(store, { pipelineId: "standalone-review", input: { diff: "a", n: 2 } });
    const cases = await casesFromRuns({ store, runIds: [runId], target: { stageId: "review" } });
    expect(cases).toEqual([
      { title: `Run ${runId.slice(0, 8)}`, input: { diff: "a", n: 2 }, metadata: { source_run: runId } },
    ]);
  });

  it("refuses runs that are not candidates", async () => {
    const store = await openStore();
    const evalRun = await addRun(store, { pipelineId: "standalone-review", input: { diff: "a" }, origin: "eval" });
    const other = await addRun(store, { pipelineId: "standalone-other", input: { diff: "a" } });
    for (const runId of [evalRun, other, "missing-run"]) {
      await expect(casesFromRuns({ store, runIds: [runId], target: { stageId: "review" } })).rejects.toMatchObject({
        code: "DATASET_CASE_OP_INVALID",
      });
    }
  });
});
