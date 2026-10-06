import { describe, expect, it } from "vitest";
import { gateCount, stageLibrary, stageMayAsk } from "./catalogJoin";
import type { PipelineListing } from "./api";

describe("catalogJoin gate_kinds three-state", () => {
  it("counts only non-empty allowlists as gates (Option A)", () => {
    const stages: Array<{ id: string; gate_kinds?: string[] }> = [
      { id: "compat" },
      { id: "no-hitl", gate_kinds: [] },
      { id: "allowlist", gate_kinds: ["confirm"] },
    ];
    expect(stageMayAsk(undefined)).toBe(false);
    expect(stageMayAsk([])).toBe(false);
    expect(stageMayAsk(["confirm"])).toBe(true);
    expect(gateCount([stages[0]!])).toBe(0);
    expect(gateCount([stages[1]!])).toBe(0);
    expect(gateCount([stages[2]!])).toBe(1);
  });

  it("preserves omitted vs empty in the stage library", () => {
    const pipelines: PipelineListing[] = [
      {
        path: "a.pipeline.yaml",
        id: "a",
        stages: [
          { id: "compat" },
          { id: "no-hitl", gate_kinds: [] },
          { id: "allowlist", gate_kinds: ["confirm"] },
        ],
      },
    ];
    const rows = stageLibrary(pipelines);
    expect(rows.find((r) => r.id === "compat")?.gate_kinds).toBeUndefined();
    expect(rows.find((r) => r.id === "no-hitl")?.gate_kinds).toEqual([]);
    expect(rows.find((r) => r.id === "allowlist")?.gate_kinds).toEqual([
      "confirm",
    ]);
  });
});
