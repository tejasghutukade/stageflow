import { describe, expect, it } from "vitest";
import {
  deriveContainerLimits,
  resetContainerLimitsForTests,
} from "../src/runtime/containerLimits.js";
import { assertClaudeNotRoot, ClaudeRootError } from "../src/preflight/claudeRoot.js";

describe("containerLimits", () => {
  it("parses max and sentinel as unlimited fallback", () => {
    resetContainerLimitsForTests();
    expect(deriveContainerLimits(undefined).maxActiveStageProcesses).toBe(4);
    expect(deriveContainerLimits(undefined).maxOldSpaceSizeMb).toBe(512);
    const twoGb = 2 * 1024 * 1024 * 1024;
    const limits = deriveContainerLimits(twoGb, "cgroup-v2");
    expect(limits.maxActiveStageProcesses).toBeGreaterThanOrEqual(1);
    expect(limits.maxActiveStageProcesses).toBeLessThanOrEqual(8);
    expect(limits.maxOldSpaceSizeMb).toBe(512);
  });
});

describe("claude root preflight", () => {
  it("refuses Claude as root", () => {
    expect(() =>
      assertClaudeNotRoot({ backendId: "claude", geteuid: () => 0 }),
    ).toThrow(ClaudeRootError);
  });

  it("allows Pi as root and Claude when geteuid undefined", () => {
    expect(() =>
      assertClaudeNotRoot({ backendId: "pi", geteuid: () => 0 }),
    ).not.toThrow();
    expect(() =>
      assertClaudeNotRoot({ backendId: "claude", geteuid: undefined }),
    ).not.toThrow();
  });
});
