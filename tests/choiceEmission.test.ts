import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import { composeStageUserPrompt } from "../src/agent/piAdapter.js";
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

const AREA_ASSIGNMENT_SCHEMA = {
  type: "object",
  properties: {
    area_id: { type: "string" },
    objective: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
  },
  required: ["area_id", "objective", "paths"],
};

const LEGAL_AREA_ASSIGNMENT = {
  area_id: "routing",
  objective: "Find the routing bug",
  paths: ["src/routing.ts"],
};

function assignmentEnvelope(payload: Record<string, unknown>) {
  return {
    status: "success" as const,
    summary: "assign",
    artifacts: [] as string[],
    payload,
  };
}

function schemaEnumValues(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const rec = schema as Record<string, unknown>;
  if (Array.isArray(rec.enum)) return rec.enum.filter((v): v is string => typeof v === "string");
  if (Array.isArray(rec.anyOf)) {
    return rec.anyOf.flatMap((item) => schemaEnumValues(item));
  }
  if (typeof rec.const === "string") return [rec.const];
  return [];
}

function cloneForkItemProperties(
  tool: ReturnType<typeof createEmitStageEnvelopeTool>,
): Record<string, unknown> | undefined {
  const params = tool.parameters as {
    properties?: { clone_forks?: { items?: { properties?: Record<string, unknown> } } };
  };
  return params.properties?.clone_forks?.items?.properties;
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

  it("AE3: successor_id tool enum names only the clonable child id", () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "oss-investigate-area", cloneCap: 5 }],
      },
    );
    const props = cloneForkItemProperties(tool);
    expect(schemaEnumValues(props?.successor_id)).toEqual(["oss-investigate-area"]);
    expect(schemaEnumValues(props?.action)).toEqual(
      expect.arrayContaining(["skip", "once", "fanout"]),
    );
  });

  it("AE3: invented successor id is rejected in-session", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "oss-investigate-area", cloneCap: 5 }],
      },
    );
    const result = await tool.execute("id1", {
      status: "success",
      summary: "invented",
      artifacts: [],
      clone_forks: [{ successor_id: "invented-successor", action: "skip" }],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/invented-successor/);
  });

  it("AE4: thin fanout assignment is rejected; verdict is not required", async () => {
    const capture = {};
    const ctx = {
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 5,
          cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
        },
      ],
    } as CloneEmitContext;
    const tool = createEmitStageEnvelopeTool(capture, undefined, undefined, ctx);
    const thin = await tool.execute("id1", {
      status: "success",
      summary: "thin",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "oss-investigate-area",
          action: "fanout",
          mode: "parallel",
          clones: [
            { envelope: assignmentEnvelope({ strategy: "search broadly" }) },
            { envelope: assignmentEnvelope({ strategy: "narrow the files" }) },
          ],
        },
      ],
    });
    expect(thin.isError).toBe(true);
    expect(thin.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();

    const legal = await tool.execute("id2", {
      status: "success",
      summary: "legal fanout",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "oss-investigate-area",
          action: "fanout",
          mode: "parallel",
          clones: [
            { envelope: assignmentEnvelope(LEGAL_AREA_ASSIGNMENT) },
            {
              envelope: assignmentEnvelope({
                ...LEGAL_AREA_ASSIGNMENT,
                area_id: "auth",
              }),
            },
          ],
        },
      ],
    });
    expect(legal.isError).toBeUndefined();
    expect(legal.terminate).toBe(true);
    expect(capture.envelope?.clone_forks?.[0]).toMatchObject({ action: "fanout" });
  });

  it("restricted clone_actions reject skip in schema and execute", async () => {
    const capture = {};
    const ctx = {
      clonableSuccessors: [{ successorId: "oss-investigate-area", cloneCap: 5 }],
      allowedActions: ["once", "fanout"],
    } as CloneEmitContext;
    const tool = createEmitStageEnvelopeTool(capture, undefined, undefined, ctx);
    const props = cloneForkItemProperties(tool);
    expect(schemaEnumValues(props?.action)).toEqual(["once", "fanout"]);
    expect(schemaEnumValues(props?.action)).not.toContain("skip");

    const result = await tool.execute("id1", {
      status: "success",
      summary: "skip anyway",
      artifacts: [],
      clone_forks: [{ successor_id: "oss-investigate-area", action: "skip" }],
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/skip/);
  });
});

describe("composeStageUserPrompt - clone emit context", () => {
  it("AE3/KTD7: prompt names legal successor id, cap, actions, and assignment schema", () => {
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots("/tmp/run-ws", "oss-plan-investigation"),
        stage: {
          id: "oss-plan-investigation",
          system_prompt: "plan",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t", goal: "plan investigation" },
        priorEnvelope: null,
        cloneEmitContext: {
          clonableSuccessors: [
            {
              successorId: "oss-investigate-area",
              cloneCap: 4,
              cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
            },
          ],
          allowedActions: ["once", "fanout"],
        } as CloneEmitContext,
      },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("oss-investigate-area");
    expect(prompt).toContain("4");
    expect(prompt).toContain("once");
    expect(prompt).toContain("fanout");
    expect(prompt).not.toMatch(/allowed clone actions:.*skip/i);
    expect(prompt).toContain(JSON.stringify(AREA_ASSIGNMENT_SCHEMA, null, 2));
    expect(prompt).toContain("area_id");
    expect(prompt).toContain("objective");
    expect(prompt).toContain("paths");
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
