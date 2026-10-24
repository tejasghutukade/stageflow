import { describe, expect, it, vi } from "vitest";
import { createSessionContextWiring } from "../src/compaction/sessionWiring.js";
import { WORKING_STATE_TOOL_NAME } from "../src/compaction/types.js";
import { WORKING_STATE_GUIDANCE } from "../src/compaction/workingState.js";
import { createAgentGateExtension } from "../src/agents/runtime/piRuntime.js";

describe("session context wiring", () => {
  it("with working state: extension, allowlist entry, guidance, budget exemption and gate pass agree", () => {
    const w = createSessionContextWiring({ workingState: true });
    expect(w.extensions.map((e) => e.name)).toEqual(["stageflow-openrouter-routing", "stageflow-compaction", "stageflow-working-state"]);
    expect(w.toolNames).toEqual([WORKING_STATE_TOOL_NAME]);
    expect(w.budgetExemptNames).toEqual([WORKING_STATE_TOOL_NAME]);
    expect(w.guidance).toBe(WORKING_STATE_GUIDANCE);
    expect(w.guidance).toContain(WORKING_STATE_TOOL_NAME);
    expect(w.isInternalTool(WORKING_STATE_TOOL_NAME)).toBe(true);
    expect(w.isInternalTool("bash")).toBe(false);
  });

  it("without working state: compaction and routing only, nothing exempt or offered", () => {
    const w = createSessionContextWiring({ workingState: false });
    expect(w.extensions.map((e) => e.name)).toEqual(["stageflow-openrouter-routing", "stageflow-compaction"]);
    expect(w.toolNames).toEqual([]);
    expect(w.budgetExemptNames).toEqual([]);
    expect(w.guidance).toBe("");
    expect(w.isInternalTool(WORKING_STATE_TOOL_NAME)).toBe(false);
  });
});

describe("agent gate extension", () => {
  function install(isInternal: (name: string) => boolean) {
    const gate = vi.fn(async () => ({ block: true as const, reason: "no" }));
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    createAgentGateExtension(gate, isInternal)({ on: (_n: string, h: typeof handler) => void (handler = h) } as never);
    return { gate, run: (toolName: string) => handler!({ toolCallId: "c", toolName, input: {} }) };
  }

  it("lets the internal working_state tool through without asking the gate, in any session", async () => {
    const wiring = createSessionContextWiring({ workingState: true });
    const { gate, run } = install(wiring.isInternalTool);
    expect(await run(WORKING_STATE_TOOL_NAME)).toBeUndefined();
    expect(gate).not.toHaveBeenCalled();
  });

  it("still gates every other tool, and gates working_state when the session has none", async () => {
    const withState = install(createSessionContextWiring({ workingState: true }).isInternalTool);
    expect(await withState.run("bash")).toEqual({ block: true, reason: "no" });
    expect(withState.gate).toHaveBeenCalledOnce();
    const without = install(createSessionContextWiring({ workingState: false }).isInternalTool);
    expect(await without.run(WORKING_STATE_TOOL_NAME)).toEqual({ block: true, reason: "no" });
  });
});
