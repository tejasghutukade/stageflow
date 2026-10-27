import { describe, expect, it } from "vitest";
import {
  acceptArtifactListedPath,
  attemptArtifactsPrefix,
  buildArtifactListedPath,
  isGrantableArtifactPath,
  parseArtifactListedPath,
} from "../src/runtime/artifactPath.js";

describe("buildArtifactListedPath / attemptArtifactsPrefix", () => {
  it("builds the run-relative grammar", () => {
    expect(
      buildArtifactListedPath({
        stageId: "plan",
        attempt: 2,
        relative: "notes/a.md",
      }),
    ).toBe("stages/plan/attempts/2/artifacts/notes/a.md");
    expect(attemptArtifactsPrefix("plan", 2)).toBe(
      "stages/plan/attempts/2/artifacts",
    );
  });
});

describe("acceptArtifactListedPath grantable", () => {
  it("parses a full run-relative artifact path", () => {
    expect(
      acceptArtifactListedPath("stages/read/attempts/1/artifacts/report.md", {
        kind: "grantable",
      }),
    ).toEqual({
      stageId: "read",
      attempt: 1,
      relative: "report.md",
    });
  });

  it("rejects work, absolute, escape, and attempt-root paths", () => {
    expect(
      acceptArtifactListedPath("stages/read/attempts/1/work/scratch.txt", {
        kind: "grantable",
      }),
    ).toBeUndefined();
    expect(
      acceptArtifactListedPath("/abs/stages/read/attempts/1/artifacts/a.md", {
        kind: "grantable",
      }),
    ).toBeUndefined();
    expect(
      acceptArtifactListedPath("stages/read/attempts/1/artifacts/../work/x.txt", {
        kind: "grantable",
      }),
    ).toBeUndefined();
    expect(
      acceptArtifactListedPath("stages/read/attempts/1/artifacts", {
        kind: "grantable",
      }),
    ).toBeUndefined();
  });

  it("keeps isGrantableArtifactPath and parseArtifactListedPath aligned", () => {
    const listed = "stages/read/attempts/3/artifacts/nested/out.json";
    expect(isGrantableArtifactPath(listed)).toBe(true);
    expect(parseArtifactListedPath(listed)).toEqual({
      stageId: "read",
      attempt: 3,
      relative: "nested/out.json",
    });
    expect(isGrantableArtifactPath("stages/read/attempts/1/artifacts")).toBe(false);
  });
});

describe("acceptArtifactListedPath current_attempt", () => {
  const mode = { kind: "current_attempt" as const, stageId: "plan", attempt: 1 };

  it("accepts the current attempt prefix and bare relatives", () => {
    expect(
      acceptArtifactListedPath("stages/plan/attempts/1/artifacts/notes.md", mode),
    ).toEqual({ stageId: "plan", attempt: 1, relative: "notes.md" });
    expect(acceptArtifactListedPath("notes.md", mode)).toEqual({
      stageId: "plan",
      attempt: 1,
      relative: "notes.md",
    });
  });

  it("rejects foreign stages and the artifacts directory itself", () => {
    expect(
      acceptArtifactListedPath("stages/other/attempts/1/artifacts/notes.md", mode),
    ).toBeUndefined();
    expect(
      acceptArtifactListedPath("stages/plan/attempts/2/artifacts/notes.md", mode),
    ).toBeUndefined();
    expect(
      acceptArtifactListedPath("stages/plan/attempts/1/artifacts", mode),
    ).toBeUndefined();
  });
});
