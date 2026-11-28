import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunDetail, StageSnapshot } from "../../api";
import {
  publishedArtifactHref,
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

  it("lists published artifacts with links when the stage has no envelope files", () => {
    const published = { key: "stage:p:s/report", version: 2, kind: "live.declarative", title: "Weekly report" };
    const publishedStage = { ...stage, artifacts: [], published_artifacts: [published] };
    const html = renderToStaticMarkup(
      createElement(RunArtifactsPanel, {
        runId: "run-1",
        run: { ...run, stages: [publishedStage] },
        stage: publishedStage,
      }),
    );
    expect(text(html)).toContain("Weekly report");
    expect(text(html)).toContain("live.declarative · v2");
    expect(html).toContain('href="#/artifacts/stage:p:s/report"');
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

  it("names the run's project in the published artifact link unless it is the workspace", () => {
    expect(publishedArtifactHref("stage:p:s/report", "workspace")).toBe("#/artifacts/stage:p:s/report");
    expect(publishedArtifactHref("stage:p:s/report")).toBe("#/artifacts/stage:p:s/report");
    expect(publishedArtifactHref("stage:p:s/report", "/repo/demo")).toBe(
      "#/artifacts/stage:p:s/report?project_root=%2Frepo%2Fdemo",
    );
    const publishedStage = {
      ...stage,
      artifacts: [],
      published_artifacts: [{ key: "stage:p:s/report", version: 1, kind: "live.declarative", title: "R" }],
    } as StageSnapshot;
    const html = renderToStaticMarkup(
      createElement(RunArtifactsPanel, {
        runId: "run-1",
        run: { ...run, project_root: "/repo/demo", stages: [publishedStage] },
        stage: publishedStage,
      }),
    );
    expect(html).toContain("project_root=%2Frepo%2Fdemo");
  });
});
