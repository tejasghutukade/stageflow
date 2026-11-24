import { describe, expect, it } from "vitest";
import type { PipelineListing } from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { buildPaletteIndex, reducePaletteArtifactSearch } from "./buildPaletteIndex";

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

  it("finds the eval commands by name", () => {
    const find = (query: string) =>
      buildPaletteIndex({ snapshot: emptySnapshot, tasks: [], pipelines: [], query, ctx });
    expect(find("new eval").find((i) => i.id === "nav-evals-new")?.context).toBe("/evals/new");
    expect(find("datasets").find((i) => i.id === "nav-datasets")?.context).toBe("/datasets");
    expect(find("evals").some((i) => i.id === "nav-evals")).toBe(true);
  });

  it("shows the top five artifact matches and opens the detail path", () => {
    const hits = Array.from({ length: 6 }, (_, index) => ({
      title: `Revenue ${index}`,
      context: "sales / summarize",
      path: `/artifacts/stage%3Asales%3Asummarize/revenue-${index}?project_root=examples`,
    }));
    const navigated: string[] = [];
    const items = buildPaletteIndex({
      snapshot: emptySnapshot,
      tasks: [],
      pipelines: [],
      query: "re",
      artifactHits: hits,
      ctx: { ...ctx, onNavigate: (path) => navigated.push(path) },
    });
    const artifacts = items.filter((item) => item.group === "artifacts");
    expect(artifacts).toHaveLength(5);
    expect(artifacts.map((item) => item.label)).toEqual([
      "Revenue 0",
      "Revenue 1",
      "Revenue 2",
      "Revenue 3",
      "Revenue 4",
    ]);
    artifacts[0]?.run();
    expect(navigated).toEqual([hits[0]!.path]);
    expect(
      buildPaletteIndex({
        snapshot: emptySnapshot,
        tasks: [],
        pipelines: [],
        query: "r",
        artifactHits: hits,
        ctx,
      }).some((item) => item.group === "artifacts"),
    ).toBe(false);
  });

  it("clears artifact hits when the query changes and drops stale responses", () => {
    const hit = { title: "Revenue", context: "sales", path: "/artifacts/a" };
    const cleared = reducePaletteArtifactSearch({ generation: 3, hits: [hit] }, { type: "query" });
    expect(cleared).toEqual({ generation: 4, hits: [] });
    expect(
      buildPaletteIndex({
        snapshot: emptySnapshot,
        tasks: [],
        pipelines: [],
        query: "re",
        artifactHits: cleared.hits,
        ctx,
      }).some((item) => item.group === "artifacts"),
    ).toBe(false);
    const stale = reducePaletteArtifactSearch(cleared, { type: "result", generation: 3, hits: [hit] });
    expect(stale).toBe(cleared);
    const failed = reducePaletteArtifactSearch(cleared, { type: "error", generation: 4 });
    expect(failed.hits).toEqual([]);
    const fresh = reducePaletteArtifactSearch(cleared, { type: "result", generation: 4, hits: [hit] });
    expect(fresh.hits).toEqual([hit]);
  });
});
