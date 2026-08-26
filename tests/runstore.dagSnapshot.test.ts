import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned");

describe("pipeline DAG snapshot persistence", () => {
  it("persists chain snapshot after createRun on include-merge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-snap-"));
    const loaded = await loadPipeline(
      path.join(owned, "include-merge/main.pipeline.yaml"),
    );
    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: snapshot,
    });

    const detail = await store.readRun(run.runId);
    expect(detail.pipeline_track.nodes.map((n) => n.stage_id)).toEqual([
      "gate",
      "finish",
    ]);
    expect(detail.pipeline_track.edges).toEqual([{ from: "gate", to: "finish" }]);
  });

  it("persists fan-out childrenOf on fork-uses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-fan-"));
    const loaded = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    expect(snapshot.childrenOf.decide).toEqual(["branch-a", "branch-b"]);

    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: fan\n",
      pipelineDag: snapshot,
    });
    const detail = await store.readRun(run.runId);
    expect(
      detail.pipeline_track.edges
        .filter((e) => e.from === "decide")
        .map((e) => e.to)
        .sort(),
    ).toEqual(["branch-a", "branch-b"]);
  });
});
