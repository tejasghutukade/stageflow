import { describe, expect, it } from "vitest";
import { applyClearing, planClearing, renderClearedIndex } from "../src/compaction/mask.js";
import { classifyForClearing } from "../src/compaction/toolPolicy.js";

const big = "x".repeat(5000);

function call(id: string, name: string, args: Record<string, unknown>) {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}
function result(id: string, name: string, text = big, extra: Record<string, unknown> = {}) {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, ...extra };
}

function convo() {
  return [
    { role: "user", content: "go" },
    call("a", "read", { path: "logs/a.log" }),
    result("a", "read"),
    call("b", "grep", { command: "ls -la" }),
    result("b", "grep", big, { details: { stageflowToolOutput: { spilled: true, path: "tool-output/b-grep.txt" } } }),
    call("c", "ask_operator", { q: "?" }),
    result("c", "ask_operator"),
    call("d", "emit_stage_envelope", {}),
    result("d", "emit_stage_envelope"),
    call("e", "grep", { pattern: "foo", path: "src" }),
    result("e", "grep", big, { isError: true }),
    call("f", "grep", { command: "cat x" }),
    result("f", "grep", "tiny"),
    call("g", "read", { path: "logs/recent.log" }),
    result("g", "read"),
    call("h", "read", { path: "logs/newest.log" }),
    result("h", "read"),
  ];
}

const policy = { keepRecentTurns: 2, minBytes: 1000 };

describe("classifyForClearing", () => {
  it("clears only re-fetchable read results", () => {
    expect(classifyForClearing("read", false)).toBe("clearable");
    expect(classifyForClearing("grep", false)).toBe("clearable");
    expect(classifyForClearing("bash", false)).toBe("keep");
    expect(classifyForClearing("ls", false)).toBe("clearable");
    expect(classifyForClearing("grep", false)).toBe("clearable");
    expect(classifyForClearing("bash", false)).toBe("keep");
    expect(classifyForClearing("stageflow_list_pipelines", false)).toBeDefined();
  });
  it("keeps errors, writes, operator, envelope, working_state, unknown, mcp", () => {
    expect(classifyForClearing("grep", true)).toBe("keep");
    expect(classifyForClearing("read", true)).toBe("keep");
    for (const t of ["ask_operator", "emit_stage_envelope", "write_stage_artifact", "write", "edit", "working_state", "mystery", "", "github_create_issue", "browser"]) {
      expect(classifyForClearing(t, false)).toBe("keep");
    }
  });
});

describe("planClearing / applyClearing", () => {
  it("clears only old, large, clearable, non-error results", () => {
    const plan = planClearing(convo(), policy);
    expect([...plan.clearIds].sort()).toEqual(["a", "b"]);
    expect(plan.cleared.every((c) => c.bytes === 5000)).toBe(true);
  });

  it("respects the recent window", () => {
    const plan = planClearing(convo(), { ...policy, keepRecentTurns: 4 });
    expect([...plan.clearIds]).toEqual(["a", "b"]);
    const all = planClearing(convo(), { ...policy, keepRecentTurns: 0 });
    expect([...all.clearIds].sort()).toEqual(["a", "b", "g", "h"]);
    expect(planClearing(convo(), { ...policy, keepRecentTurns: 50 }).clearIds.size).toBe(0);
  });

  it("builds recover hints", () => {
    const { cleared } = planClearing(convo(), policy);
    expect(cleared.find((c) => c.toolCallId === "a")!.recoverHint).toBe("read logs/a.log (offset/limit as before)");
    expect(cleared.find((c) => c.toolCallId === "b")!.recoverHint).toBe("read tool-output/b-grep.txt");
    const noSpill = [call("z", "grep", { command: "ls" }), result("z", "grep"), call("y", "read", {}), result("y", "read"), call("w", "grep", {}), result("w", "grep")];
    const plan = planClearing(noSpill, { keepRecentTurns: 1, minBytes: 1 });
    expect(plan.cleared.find((c) => c.toolCallId === "z")!.recoverHint).toBe("re-run grep with the same arguments");
    const custom = planClearing(noSpill, { keepRecentTurns: 1, minBytes: 1, recoverHintFor: () => "custom" });
    expect(custom.cleared[0]!.recoverHint).toBe("custom");
  });

  it("replaces content with a placeholder and keeps pairing fields", () => {
    const msgs = convo();
    const out = applyClearing(msgs, planClearing(msgs, policy));
    expect(out).toHaveLength(msgs.length);
    const a = out[2] as any;
    expect(a.role).toBe("toolResult");
    expect(a.toolCallId).toBe("a");
    expect(a.toolName).toBe("read");
    expect(a.isError).toBe(false);
    expect(a.content).toEqual([
      { type: "text", text: "[Tool result cleared to save context: read logs/a.log, 5000 bytes. To get it again: read logs/a.log (offset/limit as before)]" },
    ]);
    expect((out[6] as any).content[0].text).toBe(big);
    expect((out[10] as any).content[0].text).toBe(big);
    expect(out[1]).toBe(msgs[1]);
  });

  it("does not mutate input and is idempotent", () => {
    const msgs = convo();
    const snapshot = JSON.stringify(msgs);
    const once = applyClearing(msgs, planClearing(msgs, policy));
    expect(JSON.stringify(msgs)).toBe(snapshot);
    expect(once).not.toBe(msgs);
    const plan2 = planClearing(once, policy);
    expect(plan2.clearIds.size).toBe(0);
    const twice = applyClearing(once, plan2);
    expect(twice).toEqual(once);
    expect(applyClearing(once, planClearing(msgs, policy))).toEqual(once);
  });

  it("scrubs secrets from the stored descriptor and hint", () => {
    const secret = "Bearer abcdefghijklmnop1234";
    const msgs = [call("s", "grep", { pattern: `Authorization: ${secret}` }), result("s", "grep", "x".repeat(600)), call("t", "read", {}), call("u", "read", {})];
    const { cleared } = planClearing(msgs, { keepRecentTurns: 1, minBytes: 1 });
    expect(JSON.stringify(cleared)).not.toContain("abcdefghijklmnop1234");
  });

  it("counts bytes as utf8", () => {
    const text = "é".repeat(600);
    const plan = planClearing([result("u", "read", text), call("n", "grep", {}), call("m", "grep", {})], { keepRecentTurns: 1, minBytes: 1 });
    expect(plan.cleared[0]!.bytes).toBe(1200);
  });
});

describe("renderClearedIndex", () => {
  it("is bounded and reports omitted", () => {
    const msgs: any[] = [];
    for (let i = 0; i < 40; i++) msgs.push(call(`k${i}`, "read", { path: `logs/file-${i}.log` }), result(`k${i}`, "read"));
    msgs.push(call("last", "grep", {}));
    const { cleared } = planClearing(msgs, { keepRecentTurns: 1, minBytes: 1 });
    expect(cleared).toHaveLength(40);
    const out = renderClearedIndex(cleared, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith("## Cleared tool results (re-fetch if needed)")).toBe(true);
    expect(out.split("\n").at(-1)).toMatch(/^- \(\d+ more omitted\)$/);
    expect(out).toContain("logs/file-0.log");
    const full = renderClearedIndex(cleared, 100_000);
    expect(full).not.toContain("omitted");
    expect(full.split("\n")).toHaveLength(41);
  });
});
