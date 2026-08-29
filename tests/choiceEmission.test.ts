import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { CloneEmitContext, ForkEmitContext } from "../src/types/forkChoice.js";

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

function makeCloneContext(
  clonableSuccessors: CloneEmitContext["clonableSuccessors"] = [
    { successorId: "author-diagrams", cloneCap: 5 },
  ],
): CloneEmitContext {
  return { clonableSuccessors };
}

function innerEnvelope(summary = "clone prior") {
  return { status: "success" as const, summary, artifacts: [] as string[] };
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

describe("createEmitStageEnvelopeTool - clone stage", () => {
  it("AE3: success with clone context and no clone_forks → isError, no terminate, capture empty", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const result = await tool.execute("id1", {
      status: "success",
      summary: "done",
      artifacts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
  });

  it("AE5: fanout 6 clones with cap 5 → isError", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const clones = Array.from({ length: 6 }, (_, i) => ({
      envelope: innerEnvelope(`clone ${i}`),
    }));
    const result = await tool.execute("id1", {
      status: "success",
      summary: "fanout",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "fanout",
          mode: "parallel",
          clones,
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
  });

  it("AE7: no clone context → success without clone_forks accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const result = await tool.execute("id1", {
      status: "success",
      summary: "done",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.clone_forks).toBeUndefined();
    expect(
      (tool.parameters as { properties?: Record<string, unknown> }).properties
        ?.clone_forks,
    ).toBeUndefined();
  });

  it("AE-skip: legal skip is accepted and stored without envelope/mode/clones", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const result = await tool.execute("id1", {
      status: "success",
      summary: "skip diagrams",
      artifacts: [],
      clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.clone_forks).toEqual([
      { successor_id: "author-diagrams", action: "skip" },
    ]);
    expect(
      (tool.parameters as { required?: string[] }).required,
    ).toContain("clone_forks");
  });

  it("AE-once: stored envelope equals the supplied object, not the completing envelope", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const onceEnvelope = innerEnvelope("instance prior");
    const result = await tool.execute("id1", {
      status: "success",
      summary: "run once",
      artifacts: ["parent.md"],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "once",
          envelope: onceEnvelope,
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.clone_forks).toEqual([
      { successor_id: "author-diagrams", action: "once", envelope: onceEnvelope },
    ]);
    expect(capture.envelope?.summary).toBe("run once");
    const storedOnce = capture.envelope?.clone_forks?.[0];
    expect(storedOnce && "envelope" in storedOnce ? storedOnce.envelope : undefined).toEqual(
      onceEnvelope,
    );
  });

  it("AE-fanout: parallel N=2 is accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const clones = [
      { envelope: innerEnvelope("a") },
      { envelope: innerEnvelope("b") },
    ];
    const result = await tool.execute("id1", {
      status: "success",
      summary: "fanout parallel",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "fanout",
          mode: "parallel",
          clones,
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.clone_forks).toEqual([
      {
        successor_id: "author-diagrams",
        action: "fanout",
        mode: "parallel",
        clones,
      },
    ]);
  });

  it("AE-fanout: sequential N=2 is accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const clones = [
      { envelope: innerEnvelope("a") },
      { envelope: innerEnvelope("b") },
    ];
    const result = await tool.execute("id1", {
      status: "success",
      summary: "fanout sequential",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "fanout",
          mode: "sequential",
          clones,
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.clone_forks).toEqual([
      {
        successor_id: "author-diagrams",
        action: "fanout",
        mode: "sequential",
        clones,
      },
    ]);
  });

  it("fanout N=1 → isError", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const result = await tool.execute("id1", {
      status: "success",
      summary: "fanout one",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "fanout",
          mode: "parallel",
          clones: [{ envelope: innerEnvelope() }],
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
  });

  it("AE-mix: legal fork_choice plus clone_forks is accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      makeForkContext(["notify-slack"]),
      makeCloneContext([{ successorId: "author-diagrams", cloneCap: 5 }]),
    );
    const clones = [
      { envelope: innerEnvelope("e1") },
      { envelope: innerEnvelope("e2") },
    ];
    const result = await tool.execute("id1", {
      status: "success",
      summary: "mix",
      artifacts: [],
      fork_choice: ["notify-slack"],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "fanout",
          mode: "parallel",
          clones,
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.fork_choice).toEqual(["notify-slack"]);
    expect(capture.envelope?.clone_forks).toEqual([
      {
        successor_id: "author-diagrams",
        action: "fanout",
        mode: "parallel",
        clones,
      },
    ]);
  });

  it("AE-mix: clonable id in fork_choice is rejected", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      makeForkContext(["notify-slack"]),
      makeCloneContext([{ successorId: "author-diagrams", cloneCap: 5 }]),
    );
    const result = await tool.execute("id1", {
      status: "success",
      summary: "mix illegal",
      artifacts: [],
      fork_choice: ["author-diagrams"],
      clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/clone_forks/);
  });

  it("AE-fail: clone context with status failure and no clone_forks is accepted", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const result = await tool.execute("id1", {
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBe(true);
    expect(capture.envelope?.status).toBe("failure");
    expect(capture.envelope?.clone_forks).toBeUndefined();
  });

  it("already-accepted emit re-called keeps the first envelope", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );
    const first = await tool.execute("id1", {
      status: "success",
      summary: "first",
      artifacts: [],
      clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
    });
    expect(first.terminate).toBe(true);
    const second = await tool.execute("id2", {
      status: "success",
      summary: "second",
      artifacts: [],
      clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
    });
    expect(second.terminate).toBe(true);
    expect(second.content[0]?.text).toMatch(/already accepted/i);
    expect(capture.envelope?.summary).toBe("first");
  });
});

describe("FakeAgent - clone stage runtime", () => {
  it("clone context present, success omit clone_forks → runStage ok: false", async () => {
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
      cloneEmitContext: makeCloneContext(),
    });
    expect(result.ok).toBe(false);
  });

  it("clone context absent, success without clone_forks → runStage ok: true", async () => {
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
    if (result.ok) {
      expect(result.envelope.clone_forks).toBeUndefined();
    }
  });
});
