import { describe, expect, it } from "vitest";
import { createRunLiveness } from "../src/browser/runLiveness.js";

const neverCalled = {
  readRunMeta: async () => {
    throw new Error("run store must not be read for cli owners");
  },
};

describe("createRunLiveness for sf browser CLI owners", () => {
  it("treats a cli owner as live while its process runs", async () => {
    const live = createRunLiveness(neverCalled);
    expect(await live(`cli-${process.pid}-abcd1234`)).toBe(true);
  });

  it("treats a cli owner as dead when its process is gone", async () => {
    const live = createRunLiveness(neverCalled);
    expect(await live("cli-2147483646-abcd1234")).toBe(false);
  });
});
