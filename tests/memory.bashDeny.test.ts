import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryStorePathInCommand } from "../src/memory/bashDeny.js";

describe("memoryStorePathInCommand", () => {
  const home = "/data/stageflow-home";

  it("detects absolute store paths, memory segments, and STAGEFLOW_HOME references", () => {
    const store = path.join(home, "memories");
    expect(memoryStorePathInCommand(`cat ${store}/notebook/body.md`, home)).toBe(true);
    expect(memoryStorePathInCommand("ls /tmp/memories/notebook", home)).toBe(true);
    expect(memoryStorePathInCommand("echo $STAGEFLOW_HOME/memories/notebook", home)).toBe(true);
    expect(memoryStorePathInCommand("echo ${STAGEFLOW_HOME}/memories/notebook", home)).toBe(true);
  });

  it("ignores unrelated shell commands", () => {
    expect(memoryStorePathInCommand("npm test", home)).toBe(false);
    expect(memoryStorePathInCommand("cat ./README.md", home)).toBe(false);
    expect(memoryStorePathInCommand("", home)).toBe(false);
  });
});
