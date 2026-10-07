import { describe, expect, it } from "vitest";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { ForkEmitContext } from "../src/types/forkChoice.js";

function makeForkContext(
  immediateSuccessorIds: string[],
  forkShape: ForkEmitContext["forkShape"] = null,
): ForkEmitContext {
  return { immediateSuccessorIds, forkShape };
}

describe("createEmitStageEnvelopeTool - fork stage", () => {
  it("accepts valid single choice → terminate: true, no error (AE-valid)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"]);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "chose path-a",
      artifacts: [],
      fork_choice: ["path-a"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.fork_choice).toEqual(["path-a"]);
  });

  it("rejects non-immediate successor → isError, no terminate (AE5)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"]);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "jumped ahead",
      artifacts: [],
      fork_choice: ["done"],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
  });

  it("rejects missing fork_choice on success → isError (AE6)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"]);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "see report",
      artifacts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
  });
});

describe("createEmitStageEnvelopeTool - non-fork stage", () => {
  it("accepts success without fork_choice (AE-nonFork)", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "done",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.fork_choice).toBeUndefined();
  });
});
