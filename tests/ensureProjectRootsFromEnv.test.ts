import { describe, expect, it } from "vitest";
import { parseEnsureProjectRootsEnv } from "../src/project/ensureProjectRootsFromEnv.js";

describe("parseEnsureProjectRootsEnv", () => {
  it("splits comma-separated absolute paths", () => {
    expect(
      parseEnsureProjectRootsEnv({
        STAGEFLOW_ENSURE_PROJECT_ROOTS: "/catalog, /other ",
      }),
    ).toEqual(["/catalog", "/other"]);
  });

  it("returns empty when unset", () => {
    expect(parseEnsureProjectRootsEnv({})).toEqual([]);
  });
});
