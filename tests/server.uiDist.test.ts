import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultUiDistDir } from "../src/server/http.js";

describe("defaultUiDistDir", () => {
  it("resolves to packaged dist/ui, not ui/dist or src/ui", () => {
    const dir = defaultUiDistDir().replace(/\\/g, "/");
    expect(dir.endsWith("/dist/ui")).toBe(true);
    expect(dir).not.toMatch(/ui\/dist/);
    expect(path.basename(defaultUiDistDir())).toBe("ui");
  });
});
