import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvalOutcome } from "../src/config/loadEval.js";
import { validateEval } from "../src/config/validateEval.js";
import { buildEvalPlan } from "../src/evals/plan.js";
import { createInternalAgentCaseRunner } from "../src/evals/runner/internalAgentCaseRunner.js";
import { isConversation } from "../src/evals/graders/subject.js";
import { createOperatorAgentHost, type OperatorAgentModel, type OperatorAgentModelTurn } from "../src/operatorAgent/host.js";
import { createFakeOperatorAgentModel } from "../src/operatorAgent/fakeHost.js";
import { createStageflowGuideProfile } from "../src/operatorAgent/profiles/stageflowGuide.js";

const ROOT = path.join(process.cwd(), "examples/evals");
const EVAL_PATH = path.join(ROOT, "guide-behavior.eval.yaml");
const ENV = "STAGEFLOW_SHOW_INTERNAL_AGENTS";

afterEach(() => {
  delete process.env[ENV];
});

describe("internal agent evals", () => {
  it("rejects the Guide eval while internal agents are hidden", async () => {
    delete process.env[ENV];
    const loaded = await loadEvalOutcome(EVAL_PATH, ROOT);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const findings = await validateEval(loaded.value, { projectRoot: ROOT });
    expect(findings.some((f) => f.code === "eval.internal_agent_hidden")).toBe(true);
  });

  it("loads the Guide eval when internal agents are visible", async () => {
    process.env[ENV] = "1";
    const loaded = await loadEvalOutcome(EVAL_PATH, ROOT);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const findings = await validateEval(loaded.value, { projectRoot: ROOT });
    const errors = findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  it("rejects real tools", async () => {
    process.env[ENV] = "1";
    const loaded = await loadEvalOutcome(EVAL_PATH, ROOT);
    if (!loaded.ok) throw new Error("load failed");
    loaded.value.file.conversation = { ...loaded.value.file.conversation, tools: "real", allow_real_tools: true };
    const findings = await validateEval(loaded.value, { projectRoot: ROOT });
    expect(findings.some((f) => f.code === "eval.internal_agent_real_tools")).toBe(true);
  });

  it("records a delete and does not run it", async () => {
    process.env[ENV] = "1";
    const profile = createStageflowGuideProfile({ cwd: ROOT, manager: {} as never, store: {} as never });
    const host = createOperatorAgentHost(
      createFakeOperatorAgentModel([{ type: "call_tool", name: "delete_eval_run", args: { id: "er_1" }, message: "I would delete it." }]),
      [profile],
    );
    const built = await buildEvalPlan({
      projectRoot: ROOT,
      evalPath: EVAL_PATH,
      evalRunId: "er_test",
      engine: { name: "fake", version: "0", nodeVersion: process.version },
      internalAgents: [{ id: profile.id, title: profile.title, playbook: profile.playbook, tools: profile.tools.map((t) => t.name) }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.plan.modelOverride).toBe("cursor/auto");
    expect(built.plan.graders.find((g) => g.id === "says-the-point")).toMatchObject({ type: "reference", path: "final_reply" });
    const result = await createInternalAgentCaseRunner({ host: () => host }).runCase(built.plan, {
      evalRunId: "er_test",
      caseId: "g06",
      repeatIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.output || !isConversation(result.output)) throw new Error(result.ok ? "not a conversation" : result.message);
    const call = result.output.tool_calls.find((item) => item.name === "delete_eval_run");
    expect(call?.status).toBe("not_run");
    expect(call?.policy_outcome).toBe("denied");
  });

  it("saves the eval's graders in the run snapshot so the console can list them", async () => {
    process.env[ENV] = "1";
    const profile = createStageflowGuideProfile({ cwd: ROOT, manager: {} as never, store: {} as never });
    const built = await buildEvalPlan({
      projectRoot: ROOT,
      evalPath: EVAL_PATH,
      evalRunId: "er_snapshot",
      engine: { name: "fake", version: "0", nodeVersion: process.version },
      internalAgents: [{ id: profile.id, title: profile.title, playbook: profile.playbook, tools: profile.tools.map((t) => t.name) }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const definition = built.snapshot.eval.definition as { graders?: Array<{ id: string }>; target?: unknown };
    expect(definition.target).toEqual({ kind: "internal_agent", profile: profile.id });
    expect((definition.graders ?? []).map((g) => g.id)).toEqual(built.plan.graders.map((g) => g.id));
  });

  it("stops one slow case without cancelling the next", async () => {
    process.env[ENV] = "1";
    let release: (() => void) | undefined;
    let calls = 0;
    const model: OperatorAgentModel = {
      async complete(): Promise<OperatorAgentModelTurn> {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { release = () => resolve({ events: [] }); });
        return { events: [{ type: "message", role: "assistant", text: "Stageflow only." }] };
      },
      async abort() {
        release?.();
      },
    };
    const profile = createStageflowGuideProfile({ cwd: ROOT, manager: {} as never, store: {} as never });
    const host = createOperatorAgentHost(model, [profile]);
    const built = await buildEvalPlan({
      projectRoot: ROOT,
      evalPath: EVAL_PATH,
      evalRunId: "er_timeout",
      engine: { name: "fake", version: "0", nodeVersion: process.version },
      internalAgents: [{ id: profile.id, title: profile.title, playbook: profile.playbook, tools: profile.tools.map((t) => t.name) }],
    });
    if (!built.ok || !built.plan.conversation) throw new Error("plan failed");
    built.plan.conversation = { ...built.plan.conversation, turnTimeoutMs: 30 };
    const runner = createInternalAgentCaseRunner({ host: () => host });
    const slow = await runner.runCase(built.plan, { evalRunId: "er_timeout", caseId: "g01", repeatIndex: 0 });
    expect(slow.ok).toBe(false);
    if (slow.ok) return;
    expect(slow.code).toBe("EVAL_AGENT_TIMEOUT");
    const next = await runner.runCase(built.plan, { evalRunId: "er_timeout", caseId: "g02", repeatIndex: 0 });
    expect(next.ok).toBe(true);
    if (!next.ok || !next.output || !isConversation(next.output)) throw new Error(next.ok ? "not a conversation" : next.message);
    expect(next.output.final_reply).toBe("Stageflow only.");
  });
});
