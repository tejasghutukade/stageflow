import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("pipeline DAG snapshot persistence", () => {
  it("persists chain snapshot after createRun on docs-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-snap-"));
    const loaded = await loadPipeline("docs-only", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
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
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
    expect(detail.pipeline_track.edges).toEqual([
      { from: "clarify", to: "design-doc" },
      { from: "design-doc", to: "implementation-plan" },
    ]);
  });

  it("persists fan-out childrenOf on parallel-track-fanout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-fan-"));
    const loaded = await loadPipeline("parallel-track-fanout", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    expect(snapshot.childrenOf.recon).toEqual([
      "improve-a",
      "improve-b",
      "improve-c",
    ]);

    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: fan\n",
      pipelineDag: snapshot,
    });
    const detail = await store.readRun(run.runId);
    expect(
      detail.pipeline_track.edges
        .filter((e) => e.from === "recon")
        .map((e) => e.to)
        .sort(),
    ).toEqual(["improve-a", "improve-b", "improve-c"]);
  });
});
