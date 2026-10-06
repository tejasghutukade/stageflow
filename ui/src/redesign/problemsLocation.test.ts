import { describe, expect, it } from "vitest";
import { formatFindingLocation } from "./problemsLocation";

describe("formatFindingLocation", () => {
  it("returns path without line numbers", () => {
    expect(formatFindingLocation("pipelines/foo.yaml")).toBe(
      "pipelines/foo.yaml",
    );
  });
});
