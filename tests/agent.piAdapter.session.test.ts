import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  createStageSessionManager,
  ensureStageSessionFlushed,
  injectOpaqueAnswerIntoSession,
  openStageSessionManager,
  PiAgentAdapter,
  resolveStageSessionFile,
  stageSessionFilePath,
  StageSessionReconstructError,
} from "../src/agent/piAdapter.js";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import {
  bindRunWorkspaceEnv,
  buildStageRoots,
  resetBindRunWorkspaceEnvForTests,
  STAGEFLOW_RUN_WORKSPACE,
} from "../src/runtime/stageRoots.js";
import { attemptSessionPath } from "../src/runstore/workspaceLayout.js";
import { attemptContext } from "../src/runtime/stageAttemptContext.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-pi-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetBindRunWorkspaceEnvForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("StageRoots session seam", () => {
  it("bound roots keep agentDir under run workspace", () => {
    const roots = buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout");
    expect(roots.mode).toBe("bound");
    expect(roots.cwd).toBe("/tmp/checkout");
    expect(roots.agentDir).toBe("/tmp/run-ws/stages/clarify/attempts/1/.pi-agent");
    expect(roots.agentDir).not.toContain("checkout");
  });

  it("FakeAgent records StageRoots from AgentPort input", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    const roots = buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout");
    const result = await agent.runStage({
      roots,
      stage: {
        id: "clarify",
        system_prompt: "clarify",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t1", goal: "goal" },
      priorEnvelope: null,
    });
    expect(result.ok).toBe(true);
    expect(agent.lastRoots).toEqual(roots);
  });

  it("unnamed FakeAgent stages still complete via emit", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: { status: "success", summary: "unnamed", artifacts: [] },
    });
    const result = await agent.runStage({
      roots: buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout"),
      stage: {
        id: "clarify",
        system_prompt: "clarify",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t1", goal: "goal" },
      priorEnvelope: null,
    });
    expect(result).toEqual({
      ok: true,
      envelope: { status: "success", summary: "unnamed", artifacts: [] },
    });
  });

  it("bindRunWorkspaceEnv is a no-op and does not mutate process.env", () => {
    delete process.env[STAGEFLOW_RUN_WORKSPACE];
    const restore = bindRunWorkspaceEnv("/tmp/run-ws");
    expect(process.env[STAGEFLOW_RUN_WORKSPACE]).toBeUndefined();
    expect(process.env.STAGEFLOW_CHECKOUT).toBeUndefined();
    restore();
    expect(process.env[STAGEFLOW_RUN_WORKSPACE]).toBeUndefined();
  });

  it("does not overwrite a pre-existing STAGEFLOW_RUN_WORKSPACE value", () => {
    process.env[STAGEFLOW_RUN_WORKSPACE] = "/prior";
    const restore = bindRunWorkspaceEnv("/tmp/run-ws");
    expect(process.env[STAGEFLOW_RUN_WORKSPACE]).toBe("/prior");
    restore();
    expect(process.env[STAGEFLOW_RUN_WORKSPACE]).toBe("/prior");
    delete process.env[STAGEFLOW_RUN_WORKSPACE];
  });

  it("allows overlapping bindRunWorkspaceEnv for concurrent bound stages", () => {
    delete process.env[STAGEFLOW_RUN_WORKSPACE];
    const restoreA = bindRunWorkspaceEnv("/tmp/run-ws-a");
    const restoreB = bindRunWorkspaceEnv("/tmp/run-ws-b");
    expect(process.env[STAGEFLOW_RUN_WORKSPACE]).toBeUndefined();
    restoreA();
    restoreB();
  });

  it("restore is idempotent", () => {
    const restore = bindRunWorkspaceEnv("/tmp/run-ws");
    restore();
    restore();
    const restoreNext = bindRunWorkspaceEnv("/tmp/run-ws-next");
    restoreNext();
  });
});

describe("Pi stage session path layout (U3)", () => {
  it("places session under run workspace for unbound and bound roots", () => {
    const unbound = buildStageRoots("/tmp/run-ws", "clarify");
    const bound = buildStageRoots("/tmp/run-ws", "clarify", "/tmp/checkout");
    expect(stageSessionFilePath(unbound, "clarify")).toBe(
      attemptSessionPath("/tmp/run-ws", "clarify", 1),
    );
    expect(stageSessionFilePath(bound, "clarify")).toBe(
      "/tmp/run-ws/stages/clarify/attempts/1/pi-session.jsonl",
    );
    expect(stageSessionFilePath(bound, "clarify")).not.toContain("checkout");
  });

  it("uses attempt session path when roots.attempt is 2", () => {
    const roots = buildStageRoots("/tmp/run-ws", "clarify", undefined, attemptContext(2));
    expect(roots.attempt).toBe(2);
    expect(stageSessionFilePath(roots, "clarify")).toBe(
      attemptSessionPath("/tmp/run-ws", "clarify", 2),
    );
  });

  it("persists a session file after create + scripted wait-boundary messages", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    const sessionFile = ensureStageSessionFlushed(sm, "clarify");

    sm.appendMessage({
      role: "user",
      content: "start",
      timestamp: Date.now(),
    });
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_wait_1",
          name: "ask_operator",
          arguments: { prompt: "need approval" },
        },
      ],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });

    const raw = await readFile(sessionFile, "utf8");
    expect(raw).toContain('"type":"session"');
    expect(raw).toContain("ask_operator");
    expect(sessionFile).toBe(
      path.join(runWs, "stages", "clarify", "attempts", "1", "pi-session.jsonl"),
    );
  });

  it("bound roots still persist under run workspace, not checkout", async () => {
    const runWs = await makeTempDir();
    const checkout = await makeTempDir();
    const roots = buildStageRoots(runWs, "plan", checkout);
    const sm = await createStageSessionManager(roots, "plan");
    const sessionFile = ensureStageSessionFlushed(sm, "plan");
    expect(sessionFile.startsWith(runWs)).toBe(true);
    expect(sessionFile.includes(checkout)).toBe(false);
    expect(sm.getCwd()).toBe(checkout);
  });

  it("reopening an existing session rebuilds conversation context", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "prior turn",
      timestamp: Date.now(),
    });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "noted" }],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    });

    const reopened = await openStageSessionManager(roots, "clarify");
    const ctx = reopened.buildSessionContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toMatchObject({ role: "user", content: "prior turn" });
    expect(ctx.messages[1]).toMatchObject({ role: "assistant" });
  });

  it("injects opaque answer as tool result when a wait tool call is open", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "start",
      timestamp: Date.now(),
    });
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_wait_1",
          name: "ask_operator",
          arguments: { prompt: "need approval" },
        },
      ],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });

    const injected = injectOpaqueAnswerIntoSession(sm, { text: "approved" });
    expect(injected).toEqual({
      injectedAs: "tool_result",
      toolCallId: "call_wait_1",
      toolName: "ask_operator",
    });

    const roles = sm.buildSessionContext().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult"]);
  });

  it("injects opaque answer as custom message when no open tool call", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    const injected = injectOpaqueAnswerIntoSession(sm, "operator says go");
    expect(injected).toEqual({ injectedAs: "custom_message" });
    const entries = sm.getEntries();
    const custom = entries.find(
      (e) => e.type === "custom_message" || (e as { customType?: string }).customType,
    );
    expect(custom).toBeDefined();
    expect(custom).toMatchObject({
      type: "custom_message",
      customType: "stageflow.operator_answer",
    });
    expect(JSON.stringify(entries)).not.toContain(
      "software-factory.operator_answer",
    );
  });

  it("keeps session file after SessionManager work (dispose must not delete)", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    const sessionFile = ensureStageSessionFlushed(sm, "clarify");
    sm.appendMessage({
      role: "user",
      content: "keep me",
      timestamp: Date.now(),
    });
    const before = await readFile(sessionFile, "utf8");
    expect(before.length).toBeGreaterThan(0);

    const reopened = await openStageSessionManager(roots, "clarify");
    expect(reopened.getSessionFile()).toBe(sessionFile);
    expect(await readFile(sessionFile, "utf8")).toContain("keep me");
  });

  it("throws StageSessionReconstructError when session file is missing", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    await expect(openStageSessionManager(roots, "missing-stage")).rejects.toMatchObject({
      name: "StageSessionReconstructError",
      stageId: "missing-stage",
    });
    await expect(openStageSessionManager(roots, "missing-stage")).rejects.toThrow(
      /session file missing/,
    );
  });

  it("throws StageSessionReconstructError when session file is corrupt", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const sessionFile = stageSessionFilePath(roots, "clarify");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, "{not-a-pi-session\n");

    await expect(openStageSessionManager(roots, "clarify")).rejects.toBeInstanceOf(
      StageSessionReconstructError,
    );
    await expect(openStageSessionManager(roots, "clarify")).rejects.toThrow(
      /corrupt or unreadable/,
    );
  });

  it("openStage treats resumeToken as the session identity", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const resumeToken = path.join(runWs, "opaque-resume.jsonl");
    await writeFile(resumeToken, "{not-a-pi-session\n");

    const agent = new PiAgentAdapter();
    expect(() =>
      agent.openStage({
        roots,
        stage: {
          id: "clarify",
          system_prompt: "clarify",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "t1", goal: "goal" },
        priorEnvelope: null,
        resumeToken,
      }),
    ).toThrow(StageSessionReconstructError);
  });

  it("resolveStageSessionFile keeps clone sessions on the instance path", () => {
    const roots = buildStageRoots("/tmp/run-ws", "work~2");
    const input = {
      roots,
      stage: {
        id: "work",
        system_prompt: "work",
        model: "anthropic/claude-sonnet-4-5",
      },
      stageId: "work~2",
      task: { id: "t1", goal: "goal" },
      priorEnvelope: null,
    };
    expect(resolveStageSessionFile(input)).toBe(
      attemptSessionPath("/tmp/run-ws", "work~2", 1),
    );
    expect(resolveStageSessionFile(input)).not.toBe(
      attemptSessionPath("/tmp/run-ws", "work", 1),
    );
  });

  it("creates a missing session at resumeToken, not catalog stage.id", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "work~2");
    const resumeToken = attemptSessionPath(runWs, "work~2", 1);
    const catalogFile = attemptSessionPath(runWs, "work", 1);

    const sm = await createStageSessionManager(roots, "work", resumeToken);
    ensureStageSessionFlushed(sm, "work~2");

    expect(existsSync(resumeToken)).toBe(true);
    expect(existsSync(catalogFile)).toBe(false);
  });
});
