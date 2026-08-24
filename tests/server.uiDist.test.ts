import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultUiDistDir } from "../src/server/http.js";

describe("defaultUiDistDir", () => {
  it("resolves to a sibling ui dir, not ui/dist", () => {
    const dir = defaultUiDistDir().replace(/\\/g, "/");
    expect(dir).toMatch(/\/ui$/);
    expect(dir).not.toMatch(/ui\/dist/);
    expect(path.basename(defaultUiDistDir())).toBe("ui");
  });
});
