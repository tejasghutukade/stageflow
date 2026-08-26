import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { ForkEmitContext } from "../src/types/forkChoice.js";

const tempDirs: string[] = [];

beforeEach(async () => {});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-choice-"));
  tempDirs.push(dir);
  return dir;
}

function makeForkContext(
  immediateSuccessorIds: string[],
  forkShape: ForkEmitContext["forkShape"] = null,
): ForkEmitContext {
  return { immediateSuccessorIds, forkShape };
}

async function makeBaseInput(workspaceDir: string): Promise<Omit<StageRunInput, "forkEmitContext">> {
  return {
    roots: buildStageRoots(workspaceDir, "decide"),
    stage: {
      id: "decide",
      system_prompt: "decide",
      model: "anthropic/claude-sonnet-4-5",
    },
    task: { id: "t", goal: "g" },
    priorEnvelope: null,
  };
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

describe("FakeAgent - fork stage runtime", () => {
  it("missing fork_choice on success → runStage ok: false (AE6 runtime proof)", async () => {
    const workspaceDir = await makeTempDir();
    const base = await makeBaseInput(workspaceDir);
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "see report",
        artifacts: [],
      },
    });
    const result = await agent.runStage({
      ...base,
      forkEmitContext: makeForkContext(["path-a", "path-b"]),
    });
    expect(result.ok).toBe(false);
  });
});
