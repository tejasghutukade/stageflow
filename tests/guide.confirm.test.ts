import { describe, expect, it } from "vitest";
import {
  advanceGuideTurn,
  checkGuideConfirmation,
  createConfirmActionTool,
  GUIDE_CONFIRMED_TOOLS,
} from "../src/operatorAgent/profiles/guideConfirm.js";
import { createStageflowGuideProfile } from "../src/operatorAgent/profiles/stageflowGuide.js";
import type { OperatorAgentToolContext } from "../src/operatorAgent/types.js";

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

async function issue(ctx: OperatorAgentToolContext, tool: string): Promise<string> {
  const result = await createConfirmActionTool().handler({ tool, summary: `Do ${tool}` }, ctx);
  expect(result.ok).toBe(true);
  return (result.content as { confirmation_id: string }).confirmation_id;
}

describe("guide confirmations", () => {
  it("gates destructive, external and run-starting tools only", () => {
    for (const name of ["delete_eval_run", "remove_connection", "fire_trigger", "run_eval", "start_run", "enable_agent"]) {
      expect(GUIDE_CONFIRMED_TOOLS.has(name)).toBe(true);
    }
    for (const name of ["create_pipeline", "read_pipeline", "probe_project_mcp", "create_agent"]) {
      expect(GUIDE_CONFIRMED_TOOLS.has(name)).toBe(false);
    }
  });

  it("refuses without a confirmation", () => {
    const ctx = fakeCtx();
    ctx.advance();
    expect(checkGuideConfirmation("delete_eval_run", {}, ctx)?.error).toBe("guide.confirmation_required");
  });

  it("refuses a confirmation used in the same turn it was asked", async () => {
    const ctx = fakeCtx();
    ctx.advance();
    const id = await issue(ctx, "delete_eval_run");
    expect(checkGuideConfirmation("delete_eval_run", { confirmation_id: id }, ctx)?.error).toBe("guide.confirmation_pending");
  });

  it("accepts it once after the person answers, for the same tool only", async () => {
    const ctx = fakeCtx();
    ctx.advance();
    const id = await issue(ctx, "delete_eval_run");
    ctx.advance();
    expect(checkGuideConfirmation("remove_connection", { confirmation_id: id }, ctx)?.error).toBe("guide.confirmation_required");
    expect(checkGuideConfirmation("delete_eval_run", { confirmation_id: id }, ctx)).toBeNull();
    expect(checkGuideConfirmation("delete_eval_run", { confirmation_id: id }, ctx)?.error).toBe("guide.confirmation_required");
  });

  it("expires after a few turns", async () => {
    const ctx = fakeCtx();
    ctx.advance();
    const id = await issue(ctx, "fire_trigger");
    for (let i = 0; i < 4; i += 1) ctx.advance();
    expect(checkGuideConfirmation("fire_trigger", { confirmation_id: id }, ctx)?.error).toBe("guide.confirmation_required");
  });

  it("blocks a mounted Guide tool until the person confirms", async () => {
    const profile = createStageflowGuideProfile({ cwd: process.cwd(), manager: {} as never, store: {} as never });
    const remove = profile.tools.find((tool) => tool.name === "remove_connection");
    expect(remove?.description).toContain("confirmation_id");
    const ctx = fakeCtx();
    ctx.advance();
    const result = await remove!.handler({ id: "ops-mail" }, ctx);
    expect(result).toMatchObject({ ok: false, error: "guide.confirmation_required" });
  });

  it("returns a choices card and rejects tools that need no confirmation", async () => {
    const ctx = fakeCtx();
    const tool = createConfirmActionTool();
    const ok = await tool.handler({ tool: "run_eval", summary: "Run the support eval once." }, ctx);
    expect((ok.content as { ui: { component: string; question: string } }).ui).toMatchObject({
      component: "choices",
      question: "Run the support eval once.",
    });
    const no = await tool.handler({ tool: "create_pipeline", summary: "x" }, ctx);
    expect(no.error).toBe("guide.confirmation_not_needed");
  });
});
