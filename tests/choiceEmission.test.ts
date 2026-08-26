import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { assertForkChoice, createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { ForkEmitContext } from "../src/types/forkChoice.js";
import { EnvelopeError } from "../src/types/envelope.js";

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

// ─── Tool-level tests ───────────────────────────────────────────────────────

describe("assertForkChoice", () => {
  it("accepts valid single choice for immediate successor", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkChoice(
        { status: "success", fork_choice: ["path-a"] },
        ctx,
      ),
    ).not.toThrow();
  });

  it("rejects choice with non-immediate successor ID (AE5)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkChoice({ status: "success", fork_choice: ["done"] }, ctx),
    ).toThrow(EnvelopeError);
  });

  it("rejects missing fork_choice on success (AE6)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkChoice({ status: "success" }, ctx),
    ).toThrow(EnvelopeError);
  });

  it("accepts failure status without fork_choice (R7)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkChoice({ status: "failure" }, ctx),
    ).not.toThrow();
  });

  it("rejects empty fork_choice when forkShape is null (R6)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], null);
    expect(() =>
      assertForkChoice({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(EnvelopeError);
  });

  it("accepts empty fork_choice when forkShape.allowNone is true (AE3)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: true,
    });
    expect(() =>
      assertForkChoice({ status: "success", fork_choice: [] }, ctx),
    ).not.toThrow();
  });

  it("rejects empty fork_choice when forkShape.allowNone is false (AE4)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: false,
    });
    expect(() =>
      assertForkChoice({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(EnvelopeError);
  });

  it("rejects multi-choice when cardinality is one (R5)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "one",
      allowNone: false,
    });
    expect(() =>
      assertForkChoice(
        { status: "success", fork_choice: ["path-a", "path-b"] },
        ctx,
      ),
    ).toThrow(EnvelopeError);
  });
});

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

  it("rejects empty fork_choice when forkShape is null (R6)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"], null);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "empty choice",
      artifacts: [],
      fork_choice: [],
    });
    expect(result.isError).toBe(true);
    expect(capture.envelope).toBeUndefined();
  });

  it("accepts empty fork_choice when forkShape.allowNone is true (AE3)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: true,
    });
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "allowed none",
      artifacts: [],
      fork_choice: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
  });

  it("rejects empty fork_choice when forkShape.allowNone is false (AE4)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: false,
    });
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "no choice",
      artifacts: [],
      fork_choice: [],
    });
    expect(result.isError).toBe(true);
  });

  it("rejects multi-choice when cardinality is one (R5)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "one",
      allowNone: false,
    });
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "multi choice",
      artifacts: [],
      fork_choice: ["path-a", "path-b"],
    });
    expect(result.isError).toBe(true);
  });

  it("accepts failure status without fork_choice (R7)", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"]);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    const result = await tool.execute("id1", {
      status: "failure",
      summary: "failed",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
  });

  it("returns already-accepted on re-emit", async () => {
    const capture = {};
    const ctx = makeForkContext(["path-a", "path-b"]);
    const tool = createEmitStageEnvelopeTool(capture, undefined, ctx);
    await tool.execute("id1", {
      status: "success",
      summary: "first",
      artifacts: [],
      fork_choice: ["path-a"],
    });
    const result = await tool.execute("id2", {
      status: "success",
      summary: "second",
      artifacts: [],
      fork_choice: ["path-b"],
    });
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.fork_choice).toEqual(["path-a"]);
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

// ─── Runtime-level tests ─────────────────────────────────────────────────────

describe("FakeAgent - fork stage runtime", () => {
  it("valid choice → runStage ok: true, envelope has fork_choice (AE-valid runtime)", async () => {
    const workspaceDir = await makeTempDir();
    const base = await makeBaseInput(workspaceDir);
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "chose path-a",
        artifacts: [],
        fork_choice: ["path-a"],
      },
    });
    const result = await agent.runStage({
      ...base,
      forkEmitContext: makeForkContext(["path-a", "path-b"]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.fork_choice).toEqual(["path-a"]);
    }
  });

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

  it("non-immediate successor → runStage ok: false (AE5 runtime proof)", async () => {
    const workspaceDir = await makeTempDir();
    const base = await makeBaseInput(workspaceDir);
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "jumped ahead",
        artifacts: [],
        fork_choice: ["done"],
      },
    });
    const result = await agent.runStage({
      ...base,
      forkEmitContext: makeForkContext(["path-a", "path-b"]),
    });
    expect(result.ok).toBe(false);
  });

  it("non-fork stage without fork_choice → runStage ok: true (AE-nonFork runtime)", async () => {
    const workspaceDir = await makeTempDir();
    const base = await makeBaseInput(workspaceDir);
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "done",
        artifacts: [],
      },
    });
    const result = await agent.runStage(base);
    expect(result.ok).toBe(true);
  });
});
