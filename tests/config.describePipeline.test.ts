import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describePipeline } from "../src/config/describePipeline.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function describeFixture(name: string) {
  const loaded = await loadPipeline(pipelinePath(name), { cwd: fixtures });
  return { loaded, described: describePipeline(loaded) };
}

function stagesById(described: ReturnType<typeof describePipeline>) {
  return Object.fromEntries(described.stages.map((stage) => [stage.id, stage]));
}

describe("describePipeline", () => {
  it("matches diamond-fan-in scalar parents and structured join edges", async () => {
    const { loaded, described } = await describeFixture("diamond-fan-in");
    expect(described.id).toBe("diamond-fan-in");
    expect(described.path).toBe(loaded.pipelinePath);
    const byId = stagesById(described);
    expect(byId.clarify).toMatchObject({ id: "clarify", needs: null });
    expect(byId.research).toMatchObject({ id: "research", needs: "clarify" });
    expect(byId.validation).toMatchObject({ id: "validation", needs: "clarify" });
    expect(byId.synthesize?.needs).toEqual([
      { id: "research", on: ["succeeded"] },
      { id: "validation", on: ["succeeded"] },
    ]);
    expect(byId.clarify).toMatchObject({ entry: true });
    expect(byId.research).not.toHaveProperty("clone_cap");
    expect(byId.research).not.toHaveProperty("clone_mode");
    expect(byId.research).not.toHaveProperty("feedback_loop");
    expect(byId.research).not.toHaveProperty("replay_safe");
  });

  it("preserves reversed YAML declaration order for diamond join", async () => {
    const { described } = await describeFixture("diamond-fan-in-reversed");
    expect(described.id).toBe("diamond-fan-in-reversed");
    const synthesize = described.stages.find((stage) => stage.id === "synthesize");
    expect(synthesize?.needs).toEqual([
      { id: "validation", on: ["succeeded"] },
      { id: "research", on: ["succeeded"] },
    ]);
  });

  it("exposes declared on sets for accepted-failure diamond", async () => {
    const { described } = await describeFixture("diamond-fan-in-accepted");
    const synthesize = described.stages.find((stage) => stage.id === "synthesize");
    expect(synthesize?.needs).toEqual([
      { id: "research", on: ["succeeded", "failed", "skipped"] },
      { id: "validation", on: ["succeeded"] },
    ]);
  });

  it("exposes clone_cap, clone_mode, and entry on a Clone Chain emitter", async () => {
    const { described } = await describeFixture("clone-chain-smallest");
    const byId = stagesById(described);
    expect(byId["emit-items"]).toMatchObject({
      id: "emit-items",
      clone_cap: 4,
      clone_mode: "parallel",
      entry: true,
    });
    expect(byId["handle-item"]).not.toHaveProperty("clone_cap");
    expect(byId["handle-item"]).not.toHaveProperty("clone_mode");
    expect(byId.gather).not.toHaveProperty("clone_cap");
    expect(byId.gather).not.toHaveProperty("clone_mode");
  });

  it("exposes sequential clone_mode on a Clone Chain emitter", async () => {
    const { described } = await describeFixture("clone-chain-sequential");
    const emitItems = described.stages.find((stage) => stage.id === "emit-items");
    expect(emitItems).toMatchObject({
      clone_cap: 4,
      clone_mode: "sequential",
    });
  });

  it("structures a single parent when inbound if is present", async () => {
    const { described } = await describeFixture("route-if-eq");
    const byId = stagesById(described);
    expect(byId.page?.needs).toEqual([
      {
        id: "triage",
        on: ["succeeded"],
        if: { field: "severity", op: "eq", value: "high" },
      },
    ]);
    expect(byId.notify?.needs).toBe("triage");
  });

  it("exposes feedback_loop, entry, and replay_safe from a loop pipeline", async () => {
    const { described } = await describeFixture("route-loop-basic");
    const byId = stagesById(described);
    expect(byId.review).toMatchObject({
      feedback_loop: {
        target: "implement",
        max_replays: 2,
        on_max_replays: "require_continue",
        replay_session: "resume",
      },
    });
    expect(byId.plan).toMatchObject({ entry: true });
    expect(byId.submit).toMatchObject({ replay_safe: false });
    expect(byId.implement).not.toHaveProperty("feedback_loop");
    expect(byId.implement).not.toHaveProperty("entry");
    expect(byId.implement).not.toHaveProperty("replay_safe");
  });

  it("structures a single parent when on is non-default", async () => {
    const { described } = await describeFixture("route-on-failed");
    const byId = stagesById(described);
    expect(byId.hotfix?.needs).toEqual([
      {
        id: "run-tests",
        on: ["failed"],
      },
    ]);
    expect(byId.ship?.needs).toBe("run-tests");
  });

  it("copies gate_kinds from loaded stages", async () => {
    const { described } = await describeFixture("hitl-four-kinds-proving");
    const hitl = described.stages.find((stage) => stage.id === "hitl-four-kinds");
    expect(hitl?.gate_kinds).toEqual([
      "free_text",
      "confirm",
      "multi_question",
      "artifact_backed",
    ]);
  });

  it("copies on arrays so results do not alias live DAG objects", async () => {
    const { loaded, described } = await describeFixture("diamond-fan-in");
    const dagOn = loaded.dag.nodes.find((node) => node.id === "synthesize")
      ?.needsEdges[0]?.on;
    const describedNeeds = described.stages.find((stage) => stage.id === "synthesize")
      ?.needs;
    expect(Array.isArray(dagOn)).toBe(true);
    expect(Array.isArray(describedNeeds)).toBe(true);
    const describedOn = (describedNeeds as Array<{ on: string[] }>)[0]?.on;
    expect(describedOn).toEqual(["succeeded"]);
    expect(describedOn).not.toBe(dagOn);
    describedOn!.push("failed");
    expect(dagOn).toEqual(["succeeded"]);
  });
});
