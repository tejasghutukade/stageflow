import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { assignment, mint } from "../src/runtime/cloneSchedule.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const issue0 = { id: "i-1", title: "First" };
const issue1 = { id: "i-2", title: "Second" };

function emitterEnvelope(items: unknown[]): StageEnvelope {
  return {
    status: "success",
    summary: "emitted",
    artifacts: [],
    payload: { items, summary: "list" },
  };
}

describe("cloneSchedule mint", () => {
  it("mints one Clone Instance per Clone Array element, including N=1", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const two = mint(dag, "emit-items", emitterEnvelope([issue0, issue1]));
    expect(two).toMatchObject({
      kind: "minted",
      catalogChildId: "handle-item",
      instanceIds: ["handle-item~1", "handle-item~2"],
    });
    if (two.kind !== "minted") return;
    expect(two.dag.nodes.some((node) => node.id === "handle-item")).toBe(false);
    expect(two.dag.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["handle-item~1", "handle-item~2", "gather"]),
    );

    const one = mint(dag, "emit-items", emitterEnvelope([issue0]));
    expect(one).toMatchObject({
      kind: "minted",
      instanceIds: ["handle-item~1"],
    });
  });

  it("remints with nextFreeCloneSuffix on a second mint of the same emitter", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const first = mint(dag, "emit-items", emitterEnvelope([issue0, issue1]));
    expect(first.kind).toBe("minted");
    if (first.kind !== "minted") return;
    const second = mint(first.dag, "emit-items", emitterEnvelope([issue0, issue1]));
    expect(second).toMatchObject({
      kind: "minted",
      catalogChildId: "handle-item",
      instanceIds: ["handle-item~3", "handle-item~4"],
    });
  });

  it("returns none when the stage is not a Clone Chain emitter", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    expect(mint(dag, "gather", emitterEnvelope([issue0])).kind).toBe("none");
  });

  it("returns an error when the Clone Array is empty", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const outcome = mint(dag, "emit-items", emitterEnvelope([]));
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.reason).toMatch(/Clone Array "items" must contain at least one item/);
  });
});

describe("cloneSchedule assignment", () => {
  it("assigns Clone Array element n-1 to instance ~n and nothing else", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const minted = mint(dag, "emit-items", emitterEnvelope([issue0, issue1]));
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") return;
    const envelopes = new Map<string, StageEnvelope>([
      ["emit-items", emitterEnvelope([issue0, issue1])],
    ]);
    const first = assignment(minted.dag, "handle-item~1", "handle-item", envelopes);
    expect(first).toEqual({
      ok: true,
      prior: {
        status: "success",
        summary: "emitted",
        artifacts: [],
        payload: issue0,
      },
    });
    const second = assignment(minted.dag, "handle-item~2", "handle-item", envelopes);
    expect(second).toEqual({
      ok: true,
      prior: {
        status: "success",
        summary: "emitted",
        artifacts: [],
        payload: issue1,
      },
    });
    expect(assignment(minted.dag, "gather", "gather", envelopes)).toBeUndefined();
    expect(assignment(dag, "handle-item", "handle-item", envelopes)).toBeUndefined();
  });
});
