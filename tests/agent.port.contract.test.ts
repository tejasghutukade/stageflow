import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgent, fakeHitlResumePath } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";

/**
 * `@anthropic-ai/claude-agent-sdk` is mocked here (not just in
 * tests/agent.claudeAdapter.test.ts) so `ClaudeAgentAdapter` can join the
 * parameterized "AgentPort contract" suite below without spawning a
 * subprocess or spending API budget — same approach, separate module
 * registry per Vitest test file, so this has no effect on FakeAgent tests
 * in this same file.
 */
type MockToolDef = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
};

let claudeQueryImpl: (options: Record<string, unknown>) => AsyncGenerator<unknown>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    _description: string,
    _inputSchema: unknown,
    handler: MockToolDef["handler"],
  ): MockToolDef => ({ name, handler }),
  createSdkMcpServer: (opts: { name: string; tools: MockToolDef[] }) => ({
    type: "sdk",
    name: opts.name,
    instance: { tools: opts.tools },
  }),
  query: vi.fn((params: { options: Record<string, unknown> }) => claudeQueryImpl(params.options)),
}));

function findClaudeTool(options: Record<string, unknown>, name: string): MockToolDef {
  const mcpServers = options.mcpServers as Record<string, { instance: { tools: MockToolDef[] } }>;
  const found = mcpServers.stageflow.instance.tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-port-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const baseInput: StageRunInput = {
  roots: buildStageRoots("/tmp", "clarify"),
  stage: {
    id: "clarify",
    system_prompt: "clarify",
    model: "anthropic/claude-sonnet-4-5",
  },
  task: { id: "t1", goal: "goal" },
  priorEnvelope: null,
};

describe("AgentPort contract", () => {
  it("fake agent emit success returns checked envelope", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "success",
        summary: "ok",
        artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
      },
    });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.summary).toBe("ok");
    }
  });

  it("fake agent that never emits yields failure", async () => {
    const agent = new FakeAgent({ type: "never_emit" });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
  });

  it("emit tool rejects missing required fields", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    const out = await tool.execute("1", {
      status: "success",
      summary: "x",
    });
    expect(out.isError).toBe(true);
    expect(capture).not.toHaveProperty("envelope");
  });

  it("emit with status:failure yields stage failure", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: {
        status: "failure",
        summary: "blocked",
        artifacts: [],
      },
    });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.envelope?.status).toBe("failure");
    }
  });

  it("ignores later emit_stage_envelope calls after first valid envelope", async () => {
    const capture = {};
    const tool = createEmitStageEnvelopeTool(capture);
    await tool.execute("1", {
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    await tool.execute("2", {
      status: "success",
      summary: "should be ignored",
      artifacts: ["x.md"],
    });
    expect(capture).toMatchObject({
      envelope: { status: "failure", summary: "blocked" },
    });
    expect(capture.envelope?.status).toBe("failure");
  });

  it("priorEnvelope null is accepted for first-stage calls", async () => {
    const agent = new FakeAgent({
      type: "emit",
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    await expect(agent.runStage({ ...baseInput, priorEnvelope: null })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("FakeAgent parks and resumes via its HITL file, ignoring resumeToken", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "clarify");
    const input: StageRunInput = {
      ...baseInput,
      roots,
      resumeToken: "/not/a/pi/session.jsonl",
    };
    const behavior = {
      type: "wait_then_emit" as const,
      waitRequests: ["need-input"],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    };

    const first = new FakeAgent(behavior).openStage(input);
    const waiting = await first.next();
    expect(waiting.status).toBe("waiting_for_input");
    await first.close({ park: true });

    const resumed = new FakeAgent(behavior).openStage(input);
    resumed.deliverAnswer("go");
    const done = await resumed.next();
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.result).toEqual({
        ok: true,
        envelope: { status: "success", summary: "ok", artifacts: [] },
      });
    }
    await resumed.close();
  });

  it("runStage fail-closes when the handle waits", async () => {
    const runWs = await makeTempDir();
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    const result = await agent.runStage({
      ...baseInput,
      roots: buildStageRoots(runWs, "clarify"),
    });
    expect(result).toEqual({
      ok: false,
      reason: "stage requested wait; use openStage/deliverAnswer",
    });
  });

  it("keys fake HITL resume and handle id by instance stageId", async () => {
    const runWs = await makeTempDir();
    const roots = buildStageRoots(runWs, "work~2");
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: { status: "success", summary: "ok", artifacts: [] },
    });
    const handle = agent.openStage({
      roots,
      stage: {
        id: "work",
        system_prompt: "work",
        model: "anthropic/claude-sonnet-4-5",
      },
      stageId: "work~2",
      task: { id: "t1", goal: "goal" },
      priorEnvelope: null,
    });
    const waiting = await handle.next();
    expect(waiting.status).toBe("waiting_for_input");
    expect(handle.stageId).toBe("work~2");
    expect(existsSync(fakeHitlResumePath(roots, "work~2"))).toBe(true);
    expect(existsSync(fakeHitlResumePath(roots, "work"))).toBe(false);
    await handle.close({ park: true });
  });
});

/**
 * Same scenarios, run against every backend that has a scriptable test seam
 * — proof that "emit success" / "emit failure" / "never emit" behave
 * identically at the `AgentPort` contract level regardless of which adapter
 * is behind it, matching decision 5 ("two backends, two mechanisms, one
 * contract") from the adapter's plan doc.
 *
 * `PiAgentAdapter` is deliberately not part of this parameterized run: it
 * has no equivalent scriptable seam (unlike `FakeAgent`'s built-in
 * scripting or the Claude adapter's mocked-SDK tests, driving Pi
 * deterministically would mean either a live model call or new test-only
 * plumbing added to `piAdapter.ts` — out of scope here, and unnecessary,
 * since Pi's own wiring is already covered by its dedicated
 * `tests/agent.piAdapter.*.test.ts` files). This is a documented scoping
 * choice, not an oversight.
 */
type ContractScenario =
  | { type: "emit_success"; summary: string; artifacts: string[] }
  | { type: "emit_failure"; summary: string }
  | { type: "never_emit" };

type ContractDriver = {
  name: string;
  makeAgent(scenario: ContractScenario): Promise<AgentPort>;
};

const fakeAgentDriver: ContractDriver = {
  name: "FakeAgent",
  async makeAgent(scenario) {
    if (scenario.type === "emit_success") {
      return new FakeAgent({
        type: "emit",
        envelope: { status: "success", summary: scenario.summary, artifacts: scenario.artifacts },
      });
    }
    if (scenario.type === "emit_failure") {
      return new FakeAgent({
        type: "emit",
        envelope: { status: "failure", summary: scenario.summary, artifacts: [] },
      });
    }
    return new FakeAgent({ type: "never_emit" });
  },
};

const claudeAgentDriver: ContractDriver = {
  name: "ClaudeAgentAdapter",
  async makeAgent(scenario) {
    claudeQueryImpl = async function* (options) {
      if (scenario.type === "never_emit") {
        yield { type: "result", subtype: "success", is_error: false, result: "done" };
        return;
      }
      const envelope =
        scenario.type === "emit_success"
          ? { status: "success" as const, summary: scenario.summary, artifacts: scenario.artifacts }
          : { status: "failure" as const, summary: scenario.summary, artifacts: [] };
      const emitTool = findClaudeTool(options, "emit_stage_envelope");
      await emitTool.handler(envelope, undefined);
      yield { type: "result", subtype: "success", is_error: false, result: "ok" };
    };
    const { ClaudeAgentAdapter } = await import("../src/agent/claudeAdapter.js");
    return new ClaudeAgentAdapter();
  },
};

const drivers = [fakeAgentDriver, claudeAgentDriver];

describe.each(drivers)("AgentPort contract — parameterized ($name)", (driver) => {
  it("emit success returns an advancing envelope", async () => {
    const agent = await driver.makeAgent({
      type: "emit_success",
      summary: "ok",
      artifacts: ["stages/clarify/attempts/1/artifacts/a.md"],
    });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.summary).toBe("ok");
  });

  it("emit with status:failure yields a non-advancing stage failure", async () => {
    const agent = await driver.makeAgent({ type: "emit_failure", summary: "blocked" });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.envelope?.status).toBe("failure");
  });

  it("a turn that never calls emit_stage_envelope fails closed", async () => {
    const agent = await driver.makeAgent({ type: "never_emit" });
    const result = await agent.runStage(baseInput);
    expect(result.ok).toBe(false);
  });
});
