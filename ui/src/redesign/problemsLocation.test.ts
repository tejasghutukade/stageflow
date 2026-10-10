import { describe, expect, it } from "vitest";
import { formatFindingLocation } from "./problemsLocation";

describe("formatFindingLocation", () => {
  it("returns path without line numbers", () => {
    expect(formatFindingLocation("pipelines/foo.yaml")).toBe(
      "pipelines/foo.yaml",
    );
  });

  it("appends the line when one is set", () => {
    expect(formatFindingLocation("pipelines/foo.yaml", 12)).toBe(
      "pipelines/foo.yaml:12",
    );
  });
});
