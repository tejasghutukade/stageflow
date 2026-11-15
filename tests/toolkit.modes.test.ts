import { afterEach, describe, expect, it } from "vitest";
import { createEvalGate } from "../src/agents/evalGate.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { placeGuideWriteArgs } from "../src/guide/writeRoot.js";
import { createOperatorEvalGate } from "../src/operatorAgent/evalGate.js";
import {
  advanceGuideTurn,
  checkGuideConfirmation,
  createConfirmActionTool,
} from "../src/operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentToolContext } from "../src/operatorAgent/types.js";
import { checkAgentCaller } from "../src/toolkit/guard.js";
import { guideConfirmationOutcome } from "../src/toolkit/modePolicy.js";
import { MODE_RESOLVERS, registerModeResolver, resolveMode } from "../src/toolkit/modes.js";

const MODE_RESOLVER_FIXTURES: Array<{
  tool: string;
  accept: { args: Record<string, unknown>; expectedMode: string };
  reject: { args: Record<string, unknown>; messageIncludes?: string };
}> = [
  {
    tool: "decide_agent_action",
    accept: { args: { id: "boss", sessionId: "s1", action: "approve" }, expectedMode: "approve" },
    reject: { args: { id: "boss", sessionId: "s1", action: "bogus" }, messageIncludes: "approve" },
  },
  {
    tool: "delete_runs",
    accept: { args: { runId: "r1" }, expectedMode: "delete" },
    reject: { args: {}, messageIncludes: "Exactly one of runId or gc: true is required" },
  },
  {
    tool: "get_agent",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { view: "definition" }, messageIncludes: "id is required when view or revision fields are set" },
  },
  {
    tool: "get_agent_session",
    accept: { args: { id: "boss" }, expectedMode: "list" },
    reject: { args: { id: "boss", status: "bogus" }, messageIncludes: "open" },
  },
  {
    tool: "get_connection",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { id: "x" }, messageIncludes: "Unrecognized key" },
  },
  {
    tool: "get_eval",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { view: "definition" }, messageIncludes: "eval_id is required when view or grader_id is set" },
  },
  {
    tool: "get_eval_failures",
    accept: { args: { eval_run_id: "er1" }, expectedMode: "suggestions" },
    reject: { args: { eval_run_id: "er1", view: "bogus" }, messageIncludes: "suggestions" },
  },
  {
    tool: "get_eval_results",
    accept: { args: { eval_run_id: "er1" }, expectedMode: "list" },
    reject: { args: {}, messageIncludes: "expected string" },
  },
  {
    tool: "get_eval_run",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { view: "export" }, messageIncludes: "eval_run_id is required when view is set" },
  },
  {
    tool: "get_function",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { id: "fn", view: "bogus" }, messageIncludes: "definition" },
  },
  {
    tool: "get_memory",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { id: "" }, messageIncludes: "id must not be empty" },
  },
  {
    tool: "get_run",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { status: "bogus" }, messageIncludes: "created" },
  },
  {
    tool: "get_stage",
    accept: { args: { runId: "r1", stageId: "s1", view: "events" }, expectedMode: "events" },
    reject: { args: { runId: "r1", stageId: "s1", view: "bogus" }, messageIncludes: "events" },
  },
  {
    tool: "get_trigger",
    accept: { args: {}, expectedMode: "list" },
    reject: { args: { id: "" }, messageIncludes: "id must not be empty" },
  },
  {
    tool: "list_catalog",
    accept: { args: { kind: "pipelines" }, expectedMode: "pipelines" },
    reject: { args: { kind: "bogus" }, messageIncludes: "pipelines" },
  },
  {
    tool: "list_waiting",
    accept: { args: {}, expectedMode: "full" },
    reject: { args: { detail: "bogus" }, messageIncludes: "full" },
  },
  {
    tool: "read_pipeline",
    accept: { args: { path: "pipelines/hello.pipeline.yaml" }, expectedMode: "package" },
    reject: { args: {}, messageIncludes: "expected string" },
  },
  {
    tool: "review_eval_results",
    accept: { args: { eval_run_id: "er1", action: "dismiss", ids: ["s1"] }, expectedMode: "dismiss" },
    reject: { args: { eval_run_id: "er1", action: "bogus" }, messageIncludes: "label" },
  },
  {
    tool: "run_files",
    accept: { args: { runId: "r1", view: "diff" }, expectedMode: "diff" },
    reject: { args: { runId: "r1", view: "bogus" }, messageIncludes: "artifact" },
  },
  {
    tool: "save_agent",
    accept: { args: { mode: "create", definition: {} }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_connection",
    accept: { args: { mode: "create", provider: "slack" }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_dataset",
    accept: { args: { mode: "create", name: "ds1", cases: [] }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_eval",
    accept: { args: { mode: "create", definition: {} }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_function",
    accept: { args: { mode: "create", definition: {} }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_memory",
    accept: { args: { mode: "create", id: "m1", description: "Team norms" }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "save_trigger",
    accept: {
      args: { mode: "create", directory: "triggers", id: "nightly", pipeline: "hello.pipeline.yaml", kind: "manual" },
      expectedMode: "create",
    },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "set_agent_enabled",
    accept: { args: { id: "boss", enabled: true }, expectedMode: "enable" },
    reject: { args: { id: "boss" }, messageIncludes: "expected boolean" },
  },
  {
    tool: "stage_action",
    accept: { args: { runId: "r1", stageId: "s1", action: "retry" }, expectedMode: "retry" },
    reject: { args: { runId: "r1", stageId: "s1", action: "bogus" }, messageIncludes: "retry" },
  },
  {
    tool: "start_run",
    accept: { args: { pipeline: "hello.pipeline.yaml" }, expectedMode: "pipeline" },
    reject: { args: {}, messageIncludes: "Exactly one of pipeline, stage, or from_run is required" },
  },
  {
    tool: "validate",
    accept: { args: { kind: "catalog" }, expectedMode: "catalog" },
    reject: { args: { kind: "pipeline" }, messageIncludes: "pipeline is required when kind is pipeline" },
  },
  {
    tool: "write_pipeline",
    accept: { args: { mode: "create", directory: "pipelines" }, expectedMode: "create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "write_stage",
    accept: { args: { mode: "create", path: "pipelines/hello/stages/check.stage.yaml" }, expectedMode: "pipeline_create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
  {
    tool: "write_task",
    accept: { args: { mode: "create", directory: "tasks", id: "t1", goal: "Do the thing" }, expectedMode: "standalone_create" },
    reject: { args: { mode: "bogus" }, messageIncludes: "create" },
  },
];

const STAGE_ACTION_RESOLVER = (args: Record<string, unknown>) => {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (!action) return { ok: false as const, message: "action is required" };
  return { ok: true as const, resolved: { mode: action, primaryId: runId || undefined } };
};

function fakeCtx(): OperatorAgentToolContext & { advance(): void } {
  let context: unknown = { kind: "stageflow_guide" };
  return {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    emitProposal: () => {},
    advance: () => {
      context = advanceGuideTurn(context);
    },
  };
}

async function issue(
  ctx: OperatorAgentToolContext,
  tool: string,
  extra: { action?: string; id?: string } = {},
): Promise<string> {
  const result = await createConfirmActionTool().handler({ tool, summary: `Do ${tool}`, ...extra }, ctx);
  expect(result.ok).toBe(true);
  return (result.content as { confirmation_id: string }).confirmation_id;
}

describe("resolveMode", () => {
  afterEach(() => {
    registerModeResolver("stage_action", undefined);
    registerModeResolver("escalation_probe", undefined);
    registerModeResolver("get_run", undefined);
    registerModeResolver("write_pipeline", undefined);
  });

  it("covers every production MODE_RESOLVERS entry with accept and reject", () => {
    expect(Object.keys(MODE_RESOLVERS).sort()).toEqual(MODE_RESOLVER_FIXTURES.map((row) => row.tool).sort());
    for (const { tool, accept, reject } of MODE_RESOLVER_FIXTURES) {
      expect(resolveMode(tool, accept.args), tool).toMatchObject({
        ok: true,
        resolved: { mode: accept.expectedMode },
      });
      const denied = resolveMode(tool, reject.args);
      expect(denied?.ok, tool).toBe(false);
      if (denied && !denied.ok && reject.messageIncludes) {
        expect(denied.message, tool).toContain(reject.messageIncludes);
      }
    }
  });

  it("requires confirmation for a destructive resolved mode", () => {
    expect(resolveMode("delete_runs", { runId: "r1" })).toMatchObject({ ok: true });
    expect(guideConfirmationOutcome("delete_runs", { runId: "r1" })).toBe("required");
  });

  it("denies the guard when the resolver rejects", async () => {
    registerModeResolver("escalation_probe", () => ({ ok: false, message: "bad args" }));
    const parsed = parseAgentDefinition({ id: "boss", name: "boss", instructions: "x" });
    if (!parsed.ok) throw new Error("fixture");
    const refused = await checkAgentCaller("escalation_probe", {}, { agentId: "boss", definition: parsed.value }, undefined, "/x");
    expect(refused?.message).toBe("bad args");
  });

  it("denies agent and operator eval gates when the resolver rejects", () => {
    registerModeResolver("get_run", () => ({ ok: false, message: "bad args" }));
    const definition = parseAgentDefinition({
      id: "x",
      name: "x",
      instructions: "x",
      tools: { stageflow: { tools: ["get_run"] } },
    });
    if (!definition.ok) throw new Error("fixture");
    const gate = createEvalGate({
      policy: { tools: "read_only", approvals: "deny", readOnlyTools: ["stageflow.get_run"], mocks: {} },
      definition: definition.value,
    });
    const decision = gate.decide({ id: "1", tool: "stageflow.get_run", input: {} });
    expect(decision).toEqual({ allow: false, reason: "bad args" });

    const operatorGate = createOperatorEvalGate({ policy: { tools: "read_only", mocks: {} }, turn: () => 1 });
    const refused = operatorGate.decide("get_run", {});
    expect(refused?.content).toMatchObject({ message: "bad args" });
  });

  it("refuses placement when the resolver rejects", () => {
    registerModeResolver("write_pipeline", () => ({ ok: false, message: "bad args" }));
    expect(placeGuideWriteArgs("write_pipeline", { id: "hello" })).toEqual({ ok: false, message: "bad args" });
  });

  it("runs without confirmation_id when the resolved mode does not need confirmation", () => {
    registerModeResolver("get_run", (args) => ({
      ok: true,
      resolved: { mode: "single", primaryId: typeof args.runId === "string" ? args.runId : undefined },
    }));
    const ctx = fakeCtx();
    ctx.advance();
    expect(guideConfirmationOutcome("get_run", { runId: "run-a" })).toBe("none");
    expect(checkGuideConfirmation("get_run", { runId: "run-a" }, ctx)).toBeNull();
  });

  it("requires confirmation for resolver-rejected guide input", () => {
    registerModeResolver("stage_action", STAGE_ACTION_RESOLVER);
    const ctx = fakeCtx();
    ctx.advance();
    expect(checkGuideConfirmation("stage_action", { action: "" }, ctx)?.error).toBe("guide.confirmation_required");
  });
});

describe("stage_action confirmations", () => {
  afterEach(() => registerModeResolver("stage_action", undefined));

  it("honors an exact tool, action, and id match only", async () => {
    registerModeResolver("stage_action", STAGE_ACTION_RESOLVER);
    const ctx = fakeCtx();
    ctx.advance();
    const id = await issue(ctx, "stage_action", { action: "retry", id: "run-a" });
    ctx.advance();
    expect(checkGuideConfirmation("stage_action", { confirmation_id: id, action: "recover", runId: "run-a" }, ctx)?.error).toBe(
      "guide.confirmation_mismatch",
    );
    expect(checkGuideConfirmation("stage_action", { confirmation_id: id, action: "retry", runId: "run-b" }, ctx)?.error).toBe(
      "guide.confirmation_mismatch",
    );
    expect(checkGuideConfirmation("stage_action", { confirmation_id: id, action: "retry", runId: "run-a" }, ctx)).toBeNull();
  });

  it("refuses a confirmation that omits id when the call carries one", async () => {
    registerModeResolver("stage_action", STAGE_ACTION_RESOLVER);
    const ctx = fakeCtx();
    ctx.advance();
    const issued = await createConfirmActionTool().handler(
      { tool: "stage_action", action: "retry", id: "run-a", summary: "Retry run a" },
      ctx,
    );
    const id = (issued.content as { confirmation_id: string }).confirmation_id;
    const context = (ctx.getContext() as { confirmations: Array<{ confirmId?: string }> }).confirmations.find((c) => c.confirmId);
    if (context) delete context.confirmId;
    ctx.advance();
    const refused = checkGuideConfirmation("stage_action", { confirmation_id: id, action: "retry", runId: "run-a" }, ctx);
    expect(refused?.error).toBe("guide.confirmation_mismatch");
    expect((refused?.content as { message: string }).message).toContain("missing id");
  });

  it("requires confirm_action to include id when the mode needs it", async () => {
    registerModeResolver("stage_action", STAGE_ACTION_RESOLVER);
    const ctx = fakeCtx();
    const refused = await createConfirmActionTool().handler({ tool: "stage_action", action: "retry", summary: "Retry run a" }, ctx);
    expect(refused.error).toBe("guide.confirmation_field_required");
    expect((refused.content as { message: string }).message).toContain("id");
  });

  it("requires stop_recovery confirmation like other stage_action modes", () => {
    expect(
      guideConfirmationOutcome("stage_action", { action: "stop_recovery", runId: "run-a", stageId: "design" }),
    ).toBe("required");
  });
});

describe("start_run confirmations", () => {
  it("requires action on confirm_action and refuses a mode swap", async () => {
    const ctx = fakeCtx();
    const missing = await createConfirmActionTool().handler({ tool: "start_run", summary: "Start a pipeline" }, ctx);
    expect(missing.error).toBe("guide.confirmation_field_required");
    expect((missing.content as { message: string }).message).toContain("action");

    ctx.advance();
    const issued = await createConfirmActionTool().handler(
      { tool: "start_run", action: "pipeline", summary: "Start pipeline hello" },
      ctx,
    );
    expect(issued.ok).toBe(true);
    const id = (issued.content as { confirmation_id: string }).confirmation_id;
    ctx.advance();
    expect(
      checkGuideConfirmation(
        "start_run",
        { confirmation_id: id, stage: { id: "solo", uses: "stages/check.yaml" } },
        ctx,
      )?.error,
    ).toBe("guide.confirmation_mismatch");
    expect(checkGuideConfirmation("start_run", { confirmation_id: id, pipeline: "hello" }, ctx)).toBeNull();
  });
});

describe("save_trigger confirmation modes", () => {
  it("requires confirmation for create with enabled true, not omitted or false", () => {
    expect(
      guideConfirmationOutcome("save_trigger", {
        mode: "create",
        enabled: true,
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        kind: "manual",
      }),
    ).toBe("required");
    expect(
      guideConfirmationOutcome("save_trigger", {
        mode: "create",
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        kind: "manual",
      }),
    ).toBe("none");
    expect(
      guideConfirmationOutcome("save_trigger", {
        mode: "create",
        enabled: false,
        directory: "triggers",
        id: "nightly",
        pipeline: "hello",
        kind: "manual",
      }),
    ).toBe("none");
  });

  it("classifies enable-only separately from a full update that sets enabled", () => {
    expect(resolveMode("save_trigger", { mode: "update", id: "nightly", enabled: true })).toMatchObject({
      ok: true,
      resolved: { mode: "enable" },
    });
    expect(
      resolveMode("save_trigger", {
        mode: "update",
        id: "nightly",
        enabled: true,
        pipeline: "hello",
        kind: "manual",
      }),
    ).toMatchObject({ ok: true, resolved: { mode: "update" } });
    expect(guideConfirmationOutcome("save_trigger", { mode: "update", id: "nightly", enabled: false })).toBe(
      "required",
    );
  });
});

describe("delete_runs GC confirmation modes", () => {
  it("separates dry-run gc from gc_execute so confirm cannot swap", () => {
    expect(resolveMode("delete_runs", { gc: true })).toMatchObject({ ok: true, resolved: { mode: "gc" } });
    expect(resolveMode("delete_runs", { gc: true, execute: true })).toMatchObject({
      ok: true,
      resolved: { mode: "gc_execute" },
    });
    expect(guideConfirmationOutcome("delete_runs", { gc: true })).toBe("required");
    expect(guideConfirmationOutcome("delete_runs", { gc: true, execute: true })).toBe("required");
  });

  it("refuses a dry-run confirmation used for execute", async () => {
    const ctx = fakeCtx();
    ctx.advance();
    const issued = await createConfirmActionTool().handler(
      { tool: "delete_runs", action: "gc", summary: "Preview GC" },
      ctx,
    );
    expect(issued.ok).toBe(true);
    const id = (issued.content as { confirmation_id: string }).confirmation_id;
    ctx.advance();
    expect(
      checkGuideConfirmation("delete_runs", { confirmation_id: id, gc: true, execute: true }, ctx)?.error,
    ).toBe("guide.confirmation_mismatch");
    expect(checkGuideConfirmation("delete_runs", { confirmation_id: id, gc: true }, ctx)).toBeNull();
  });
});
