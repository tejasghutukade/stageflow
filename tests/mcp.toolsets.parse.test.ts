import { describe, expect, it } from "vitest";
import { resolveToolsets, toolsetsQueryFromUrl } from "../src/mcp/toolsets.js";
import { TOOL_META, toolsInToolset } from "../src/toolkit/meta.js";

const CORE_TOOLS = [
  "get_started",
  "list_catalog",
  "validate",
  "read_pipeline",
  "write_pipeline",
  "write_stage",
  "write_task",
  "start_run",
  "get_run",
  "run_stats",
  "get_stage",
  "run_files",
  "wait_run",
  "stage_action",
  "cancel_run",
  "list_waiting",
  "answer_gate",
  "decide_feedback_loop",
] as const;

describe("toolsetsQueryFromUrl", () => {
  it("reads toolsets from /mcp query", () => {
    expect(toolsetsQueryFromUrl("/mcp?toolsets=evals")).toBe("evals");
  });

  it("returns repeated toolsets params as an array", () => {
    expect(toolsetsQueryFromUrl("/mcp?toolsets=evals&toolsets=agents")).toEqual(["evals", "agents"]);
  });

  it("returns undefined when the url has no query", () => {
    expect(toolsetsQueryFromUrl("/mcp")).toBeUndefined();
  });

  it("returns undefined for an undefined url", () => {
    expect(toolsetsQueryFromUrl(undefined)).toBeUndefined();
  });
});

describe("resolveToolsets", () => {
  it("defaults missing, empty and whitespace-only values to core only", () => {
    expect(resolveToolsets(undefined)).toEqual({ ok: true, tools: [...CORE_TOOLS].sort() });
    expect(resolveToolsets("")).toEqual({ ok: true, tools: [...CORE_TOOLS].sort() });
    expect(resolveToolsets("   ")).toEqual({ ok: true, tools: [...CORE_TOOLS].sort() });
    expect(resolveToolsets(" ,  , ")).toEqual({ ok: true, tools: [...CORE_TOOLS].sort() });
  });

  it("merges repeated toolsets parameters", () => {
    const result = resolveToolsets(["evals", "agents,runs"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = new Set([
      ...toolsInToolset("core"),
      ...toolsInToolset("evals"),
      ...toolsInToolset("agents"),
      ...toolsInToolset("runs"),
    ]);
    expect(result.tools).toEqual([...expected].sort());
  });

  it("normalizes case, trims and dedupes toolset names", () => {
    const result = resolveToolsets("Evals, agents ,evals");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = new Set([...toolsInToolset("core"), ...toolsInToolset("evals"), ...toolsInToolset("agents")]);
    expect(result.tools).toEqual([...expected].sort());
  });

  it("selects all tools when all appears anywhere", () => {
    expect(resolveToolsets("all,evals")).toEqual({ ok: true, tools: Object.keys(TOOL_META).sort() });
    expect(resolveToolsets("evals,all")).toEqual({ ok: true, tools: Object.keys(TOOL_META).sort() });
  });

  it("reports unknown toolset names", () => {
    expect(resolveToolsets("evals,nope")).toEqual({ ok: false, unknown: ["nope"] });
    expect(resolveToolsets("nope,yikes")).toEqual({ ok: false, unknown: ["nope", "yikes"] });
  });
});

describe("TOOL_META toolsets", () => {
  it("assigns exactly one known toolset to every tool", () => {
    const ids = new Set(toolsInToolset("core").concat(
      toolsInToolset("runs"),
      toolsInToolset("catalog"),
      toolsInToolset("agents"),
      toolsInToolset("evals"),
      toolsInToolset("functions"),
      toolsInToolset("triggers"),
      toolsInToolset("connections"),
      toolsInToolset("memories"),
      toolsInToolset("artifacts"),
    ));
    expect(ids.size).toBe(Object.keys(TOOL_META).length);
    for (const meta of Object.values(TOOL_META)) {
      expect(meta.toolset).toBeTruthy();
    }
  });

  it("puts exactly the 18 core tools in the core toolset", () => {
    expect(toolsInToolset("core").sort()).toEqual([...CORE_TOOLS].sort());
  });
});