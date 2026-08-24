import { describe, expect, it } from "vitest";
import {
  isCursorModelRef,
  resolveCursorExtensionPath,
} from "../src/agent/cursorProvider.js";
import { findProviderSupport } from "../src/agent/providerSupport.js";

describe("cursor provider support", () => {
  it("detects cursor model refs", () => {
    expect(isCursorModelRef("cursor/composer-2-5")).toBe(true);
    expect(isCursorModelRef("cursor/auto")).toBe(true);
    expect(isCursorModelRef("anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isCursorModelRef("composer-2-5")).toBe(false);
  });

  it("resolves an installed or sibling pi-cursor-sdk entry", () => {
    const resolved = resolveCursorExtensionPath();
    expect(resolved).toBeTruthy();
    expect(resolved).toMatch(/pi-cursor-sdk[/\\]src[/\\]index\.ts$/);
  });

  it("is registered as StageProviderSupport only for cursor models", () => {
    expect(findProviderSupport("cursor/composer-2-5")?.id).toBe("cursor");
    expect(findProviderSupport("anthropic/claude-sonnet-4-5")).toBeUndefined();
  });
});
