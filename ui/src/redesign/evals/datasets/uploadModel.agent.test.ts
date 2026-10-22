import { describe, expect, it } from "vitest";
import type { EvalDatasetPreview } from "../../../api/evalTypes";
import {
  SCRIPT_NOTICE,
  agentFields,
  agentPreviewRows,
  autoMatch,
  buildMapping,
  buildPreviewRequest,
  fieldSplits,
  hasTarget,
  isAgentUpload,
  recheckForMode,
  setColumn,
  setSplit,
} from "./uploadModel";

describe("agent mapping rows", () => {
  it("offers the ten scenario fields and not script or tool_mocks", () => {
    const keys = agentFields().map((f) => f.key);
    expect(keys).toEqual([
      "input.opening",
      "input.goal",
      "input.persona",
      "input.mode",
      "input.facts",
      "expected.outcome",
      "expected.tools",
      "expected.forbidden_tools",
      "title",
      "tags",
    ]);
    expect(keys).not.toContain("input.script");
    expect(keys).not.toContain("input.tool_mocks");
    expect(agentFields().every((f) => f.kind !== "required")).toBe(true);
  });

  it("splits lists: facts, expected tools, forbidden tools and tags", () => {
    const splitting = agentFields().filter(fieldSplits).map((f) => f.key);
    expect(splitting).toEqual(["input.facts", "expected.outcome", "expected.tools", "expected.forbidden_tools", "tags"]);
  });

  it("matches columns by name, ignoring case, spaces and prefixes", () => {
    const state = autoMatch(agentFields(), ["Opening", "goal", "Forbidden tools", "Title", "unrelated", "expected.tools"]);
    expect(state["input.opening"]?.column).toBe("Opening");
    expect(state["input.goal"]?.column).toBe("goal");
    expect(state["expected.forbidden_tools"]?.column).toBe("Forbidden tools");
    expect(state["title"]?.column).toBe("Title");
    expect(state["expected.tools"]?.column).toBe("expected.tools");
    expect(state["input.persona"]?.column).toBeNull();
  });

  it("builds a mapping with splits on the list fields only", () => {
    let state = autoMatch(agentFields(), ["opening", "facts", "tools", "tags"]);
    state = setColumn(state, "expected.tools", "tools");
    state = setSplit(state, "input.facts", ";");
    state = setSplit(state, "expected.tools", "|");
    state = setSplit(state, "input.opening", ",");
    const mapping = buildMapping(agentFields(), state);
    expect(mapping["input.opening"]).toEqual({ column: "opening" });
    expect(mapping["input.facts"]).toEqual({ column: "facts", split: ";" });
    expect(mapping["expected.tools"]).toEqual({ column: "tools", split: "|" });
    expect(mapping["tags"]).toEqual({ column: "tags" });
    expect(mapping["input.goal"]).toBeNull();
  });

  it("tells the author scripts and mocks need JSON", () => {
    expect(SCRIPT_NOTICE).toBe("Scripts and tool mocks need a JSON or JSONL file.");
  });
});

describe("agent previews", () => {
  it("sends the agent target and the eval for the mode", () => {
    expect(buildPreviewRequest({ format: "jsonl", content: "x", target: { agent_id: "support" }, evalId: "support-eval" })).toEqual({
      format: "jsonl",
      content: "x",
      target: { agent_id: "support" },
      eval_id: "support-eval",
    });
    expect(buildPreviewRequest({ format: "jsonl", content: "x" })).not.toHaveProperty("eval_id");
  });

  it("recognises an agent target", () => {
    expect(hasTarget({ agent_id: "support" })).toBe(true);
    expect(isAgentUpload({ agent_id: "support" })).toBe(true);
    expect(isAgentUpload({ stage_id: "review" })).toBe(false);
    expect(isAgentUpload(undefined)).toBe(false);
  });

  const preview = (): EvalDatasetPreview => ({
    rows: [
      { index: 0, case: { id: "a", input: { script: ["Hi"] }, title: "Scripted" }, status: "skipped", reason: "scenario needs opening" },
      { index: 1, case: { id: "b", input: { opening: "Hello", persona: "p", goal: "Win" } }, status: "ready" },
      { index: 2, case: { id: "c", input: {} }, status: "ready" },
    ],
    findings: [],
    counts: { ready: 2, skipped: 1 },
  });

  it("checks the rows against the mode the caller means, not the server's default", () => {
    const script = recheckForMode(preview(), "script");
    expect(script.rows.map((r) => r.status)).toEqual(["ready", "skipped", "skipped"]);
    expect(script.rows[0]).not.toHaveProperty("reason");
    expect(script.rows[1]?.reason).toMatch(/script/);
    expect(script.counts).toEqual({ ready: 1, skipped: 2 });
    const simulated = recheckForMode(preview(), "simulated");
    expect(simulated.rows.map((r) => r.status)).toEqual(["skipped", "ready", "skipped"]);
    expect(simulated.rows[0]?.reason).toBe("scenario needs opening");
  });

  it("shows the opening or first script message and the title or goal", () => {
    const rows = agentPreviewRows(preview());
    expect(rows[0]).toMatchObject({ text: "Hi", secondary: "Scripted", status: "skipped" });
    expect(rows[1]).toMatchObject({ text: "Hello", secondary: "Win", status: "ready" });
    expect(agentPreviewRows(recheckForMode(preview(), "simulated"))[2]).toMatchObject({ text: "", secondary: "(empty)", status: "skipped" });
    expect(agentPreviewRows(null)).toEqual([]);
  });
});
