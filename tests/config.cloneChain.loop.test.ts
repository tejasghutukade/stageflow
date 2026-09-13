import { describe, expect, it } from "vitest";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

async function loadIllegal(name: string) {
  const outcome = await loadPipelineOutcome(pipelinePath(name));
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return { message: "", code: "" };
  return {
    message: outcome.issues.map((issue) => issue.message).join("\n"),
    code: outcome.issues[0]?.code,
  };
}

describe("Clone Chain Loop catalog load", () => {
  it("loads a Loop from the Join to a stage before the emitter", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-loop-from-join"));
    const gather = loaded.dag.nodes.find((node) => node.id === "gather");
    expect(gather?.feedback_loop).toEqual({
      target: "prepare",
      max_replays: 2,
      on_max_replays: "require_continue",
      replay_session: "resume",
    });
    expect(loaded.dag.childrenOf.gather).toEqual(["done"]);
    const emitter = loaded.dag.nodes.find((node) => node.id === "emit-items");
    expect(emitter).toMatchObject({
      clone_cap: 4,
      clone_mode: "parallel",
      clone_array_field: "items",
    });
  });

  it("fails when a Loop targets the emitter", async () => {
    const { message, code } = await loadIllegal("clone-chain-loop-to-emitter");
    expect(code).toBe("pipeline.dag_error");
    expect(message).toMatch(/emitter/);
    expect(message).toMatch(/Loop/);
  });

  it("fails when a Loop targets the clone child", async () => {
    const { message, code } = await loadIllegal("clone-chain-loop-to-clone-child");
    expect(code).toBe("pipeline.dag_error");
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/Loop/);
  });

  it("fails when a Loop targets the Join", async () => {
    const { message, code } = await loadIllegal("clone-chain-loop-to-join");
    expect(code).toBe("pipeline.dag_error");
    expect(message).toMatch(/Join/);
    expect(message).toMatch(/Loop/);
  });

  it("fails when a Loop originates on the emitter", async () => {
    const { message, code } = await loadIllegal("clone-chain-loop-from-emitter");
    expect(code).toBe("pipeline.dag_error");
    expect(message).toMatch(/emitter/);
    expect(message).toMatch(/Loop/);
  });

  it("fails when a Loop originates on the clone child", async () => {
    const { message, code } = await loadIllegal("clone-chain-loop-from-clone-child");
    expect(code).toBe("pipeline.dag_error");
    expect(message).toMatch(/clone child/);
    expect(message).toMatch(/Loop/);
  });
});
