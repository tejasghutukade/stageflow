import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunDetail, StageSnapshot } from "../../api";
import {
  resolveArtifactsPanelSelection,
  RunArtifactsPanel,
} from "./RunArtifactsPanel";

const disk = [
  "stages/review/attempts/1/artifacts/report.md",
  "stages/review/attempts/1/artifacts/notes.json",
];

describe("resolveArtifactsPanelSelection", () => {
  it("selects an on-disk claim by exact run-relative path", () => {
    expect(resolveArtifactsPanelSelection(disk, disk[0])).toEqual({
      selected: disk[0],
      missingClaim: null,
    });
  });

  it("selects via basename fallback when forms diverge", () => {
    expect(resolveArtifactsPanelSelection(disk, "report.md")).toEqual({
      selected: disk[0],
      missingClaim: null,
    });
  });

  it("does not coerce a missing initialPath to paths[0]", () => {
    expect(
      resolveArtifactsPanelSelection(disk, "stages/review/attempts/1/artifacts/ghost.md"),
    ).toEqual({
      selected: null,
      missingClaim: "stages/review/attempts/1/artifacts/ghost.md",
    });
  });

  it("defaults to paths[0] only when no initialPath is provided", () => {
    expect(resolveArtifactsPanelSelection(disk, null)).toEqual({
      selected: disk[0],
      missingClaim: null,
    });
    expect(resolveArtifactsPanelSelection(disk, undefined)).toEqual({
      selected: disk[0],
      missingClaim: null,
    });
  });

  it("keeps a still-valid current selection when initialPath is absent", () => {
    expect(resolveArtifactsPanelSelection(disk, null, disk[1])).toEqual({
      selected: disk[1],
      missingClaim: null,
    });
  });
});

describe("RunArtifactsPanel missing claim UI", () => {
  const stage: StageSnapshot = {
    stage_id: "review",
    status: "succeeded",
    attempt_count: 1,
    artifacts: disk,
    envelope: null,
    events: [],
  };

  const run = {
    run_id: "run-1",
    stages: [stage],
  } as RunDetail;

  function text(html: string): string {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  it("shows a missing empty state instead of opening another file", () => {
    const html = renderToStaticMarkup(
      createElement(RunArtifactsPanel, {
        runId: "run-1",
        run,
        stage,
        initialPath: "stages/review/attempts/1/artifacts/ghost.md",
      }),
    );
    const out = text(html);
    expect(out).toContain("ghost.md is not on disk");
    expect(out).toContain("report.md");
    expect(out).toContain("notes.json");
  });

  it("shows missing when the stage has no disk artifacts at all", () => {
    const emptyStage = { ...stage, artifacts: [] };
    const html = renderToStaticMarkup(
      createElement(RunArtifactsPanel, {
        runId: "run-1",
        run: { ...run, stages: [emptyStage] },
        stage: emptyStage,
        initialPath: "ghost.md",
      }),
    );
    expect(text(html)).toContain("ghost.md is not on disk");
  });
});
