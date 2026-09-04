import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
  instancesOfDefinition,
  linearCompatDagSnapshot,
} from "../src/runstore/pipelineDagSnapshot.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned");

describe("pipeline DAG snapshot persistence", () => {
  it("copies successor clone_input_schema and never the child payload_schema", () => {
    const assignment = {
      type: "object",
      properties: { area_id: { type: "string" } },
      required: ["area_id"],
    };
    const output = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const snapshot = buildPipelineDagSnapshotFromLoaded({
      pipeline: { id: "clone-assign", stages: ["plan", "area"] },
      pipelinePath: "clone-assign.pipeline.yaml",
      stages: [
        {
          id: "plan",
          system_prompt: "x",
          model: "m",
          clone_actions: ["once", "fanout"],
        },
        {
          id: "area",
          system_prompt: "x",
          model: "m",
          clone_input_schema: assignment,
          payload_schema: output,
        },
      ],
      dag: {
        nodes: [
          { id: "plan", needs: null, ancestors: [], stageIndex: 0 },
          {
            id: "area",
            needs: "plan",
            ancestors: ["plan"],
            stageIndex: 1,
            clonable: true,
            clone_cap: 4,
          },
        ],
        roots: ["plan"],
        childrenOf: { plan: ["area"] },
      },
    });
    expect(snapshot.clone_input_schema?.area).toEqual(assignment);
    expect(snapshot.clone_input_schema?.area).not.toEqual(output);
    expect(JSON.stringify(snapshot)).not.toContain("verdict");
  });

  it("persists omitted vs empty vs allowlist gate_kinds (KTD1)", () => {
    const snapshot = buildPipelineDagSnapshotFromLoaded({
      pipeline: { id: "three-state", stages: ["compat", "no-hitl", "allowlist"] },
      pipelinePath: "three-state.pipeline.yaml",
      stages: [
        {
          id: "compat",
          system_prompt: "x",
          model: "m",
        },
        {
          id: "no-hitl",
          system_prompt: "x",
          model: "m",
          gate_kinds: [],
        },
        {
          id: "allowlist",
          system_prompt: "x",
          model: "m",
          gate_kinds: ["confirm"],
        },
      ],
      dag: {
        nodes: [
          {
            id: "compat",
            needs: null,
            ancestors: [],
            stageIndex: 0,
          },
          {
            id: "no-hitl",
            needs: "compat",
            ancestors: ["compat"],
            stageIndex: 1,
          },
          {
            id: "allowlist",
            needs: "no-hitl",
            ancestors: ["compat", "no-hitl"],
            stageIndex: 2,
          },
        ],
        roots: ["compat"],
        childrenOf: { compat: ["no-hitl"], "no-hitl": ["allowlist"] },
      },
    });
    expect(snapshot.gate_kinds?.compat).toBeUndefined();
    expect(snapshot.gate_kinds?.["no-hitl"]).toEqual([]);
    expect(snapshot.gate_kinds?.allowlist).toEqual(["confirm"]);
  });

  it("freeze stamps definition_id to catalog id; YAML resolution omits it", async () => {
    const loaded = await loadPipeline(
      path.join(fixtures, "pipelines/linear-explicit.pipeline.yaml"),
    );
    expect(loaded.dag.nodes.every((n) => n.definition_id === undefined)).toBe(
      true,
    );

    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    expect(snapshot.nodes.map((n) => [n.id, n.definition_id])).toEqual([
      ["clarify", "clarify"],
      ["design-doc", "design-doc"],
      ["implementation-plan", "implementation-plan"],
    ]);

    const linear = linearCompatDagSnapshot(["detect", "author-diagrams", "collect"]);
    expect(linear.nodes.map((n) => [n.id, n.definition_id])).toEqual([
      ["detect", "detect"],
      ["author-diagrams", "author-diagrams"],
      ["collect", "collect"],
    ]);
  });

  it("readRunMeta exposes pipeline_dag after createRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-meta-"));
    const loaded = await loadPipeline(
      path.join(fixtures, "pipelines/linear-explicit.pipeline.yaml"),
    );
    const snapshot = buildPipelineDagSnapshotFromLoaded(loaded);
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: snapshot,
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.pipeline_dag?.stage_ids).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
    expect(meta.pipeline_dag?.nodes.map((n) => n.definition_id)).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
  });

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

describe("appendCloneInstances", () => {
  function chainSnapshot() {
    return linearCompatDagSnapshot(["detect", "author-diagrams", "collect"]);
  }

  it("AE3: replaces catalog placeholder; join needs stay catalog id", async () => {
    const frozen = chainSnapshot();
    expect(instancesOfDefinition(frozen, "author-diagrams")).toEqual([
      "author-diagrams",
    ]);

    const { snapshot, instanceIds } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 3,
    });
    expect(instanceIds).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(snapshot.stage_ids).toEqual([
      "detect",
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
      "collect",
    ]);
    expect(snapshot.stage_ids).not.toContain("author-diagrams");
    expect(snapshot.nodes.find((n) => n.id === "author-diagrams")).toBeUndefined();
    for (const id of instanceIds) {
      const node = snapshot.nodes.find((n) => n.id === id);
      expect(node?.needs).toBe("detect");
      expect(node?.definition_id).toBe("author-diagrams");
      expect(node?.ancestors).toEqual(["detect"]);
    }
    expect(snapshot.nodes.find((n) => n.id === "collect")?.needs).toBe(
      "author-diagrams",
    );
    expect(snapshot.childrenOf.detect).toEqual(instanceIds);
    expect(snapshot.childrenOf["author-diagrams"]).toEqual(["collect"]);
    expect(instancesOfDefinition(snapshot, "author-diagrams")).toEqual(
      instanceIds,
    );

    const root = await mkdtemp(path.join(tmpdir(), "sf-dag-clone-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "clone-id",
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: frozen,
    });
    await store.updatePipelineDag(run.runId, snapshot);
    const detail = await store.readRun(run.runId);
    expect(detail.pipeline_track.nodes.map((n) => n.stage_id)).toEqual(
      snapshot.stage_ids,
    );
    expect(
      detail.pipeline_track.nodes
        .filter((n) => n.definition_id === "author-diagrams")
        .map((n) => n.stage_id),
    ).toEqual(instanceIds);
  });

  it("second mutate of the same catalog id throws", () => {
    const { snapshot } = appendCloneInstances(chainSnapshot(), {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });
    expect(() =>
      appendCloneInstances(snapshot, {
        catalogId: "author-diagrams",
        predecessorId: "detect",
        count: 2,
      }),
    ).toThrow();
  });

  it("carries the catalog completion policy to every clone", () => {
    const frozen = linearCompatDagSnapshot(["detect", "author-diagrams"]);
    const author = frozen.nodes.find((node) => node.id === "author-diagrams");
    if (!author) throw new Error("missing author-diagrams node");
    author.completion = {
      mode: "all",
      checks: [{ id: "tests", type: "command", run: "npm test" }],
    };
    author.recovery = {
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    };

    const { snapshot, instanceIds } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });

    for (const id of instanceIds) {
      const clone = snapshot.nodes.find((node) => node.id === id);
      expect(clone?.completion).toEqual(author.completion);
      expect(clone?.recovery).toEqual(author.recovery);
    }
  });

  it("moves nested clone predecessor off the YAML parent in childrenOf", () => {
    const frozen = linearCompatDagSnapshot(["a", "b", "c", "d"]);
    const afterB = appendCloneInstances(frozen, {
      catalogId: "b",
      predecessorId: "a",
      count: 2,
    }).snapshot;
    const afterC = appendCloneInstances(afterB, {
      catalogId: "c",
      predecessorId: "b~1",
      count: 2,
    }).snapshot;
    expect(afterC.childrenOf["b~1"]).toEqual(["c~1", "c~2"]);
    expect(afterC.childrenOf.b ?? []).not.toContain("c");
    expect(afterC.childrenOf.c).toEqual(["d"]);
    expect(afterC.nodes.find((n) => n.id === "d")?.needs).toBe("c");
    expect(afterC.nodes.find((n) => n.id === "c~1")?.needs).toBe("b~1");
  });
});
