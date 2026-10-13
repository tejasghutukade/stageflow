import { describe, expect, it } from "vitest";
import type { PipelineListing } from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { buildPaletteIndex } from "./buildPaletteIndex";

const emptySnapshot: CatalogSnapshot = {
  runs: [],
  health: null,
};

const ctx = {
  onStartRun: () => {},
  onNavigate: () => {},
};

describe("buildPaletteIndex", () => {
  it("ranks retry action when query matches", () => {
    const items = buildPaletteIndex({
      snapshot: emptySnapshot,
      tasks: [],
      pipelines: [],
      query: "retry",
      ctx: {
        ...ctx,
        firstBrokenRunId: "run-broken-1",
      },
    });
    expect(items.some((i) => i.id === "action-retry-failed")).toBe(true);
    expect(items[0]?.id).toBe("action-retry-failed");
  });

  it("matches pipeline id in query", () => {
    const pipelines: PipelineListing[] = [
      {
        id: "feature-ship",
        path: "pipelines/feature-ship.yaml",
        stages: [{ id: "plan", gate_kinds: [] }],
      },
    ];
    const items = buildPaletteIndex({
      snapshot: emptySnapshot,
      tasks: [],
      pipelines,
      query: "feature",
      ctx,
    });
    expect(items.some((i) => i.group === "pipelines" && i.label === "feature-ship")).toBe(
      true,
    );
  });

  it("returns nav and top actions on empty query", () => {
    const items = buildPaletteIndex({
      snapshot: emptySnapshot,
      tasks: [],
      pipelines: [],
      query: "",
      ctx,
    });
    expect(items.some((i) => i.id === "action-start-run")).toBe(true);
    expect(items.some((i) => i.group === "navigation")).toBe(true);
  });
});
