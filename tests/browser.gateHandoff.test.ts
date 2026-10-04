import { describe, expect, it } from "vitest";
import {
  hostGateContextFor,
  parseHostGateContext,
  stampGateRequest,
} from "../src/browser/gateHandoff.js";
import { tryParsePendingPrompt } from "../src/runtime/stageHitl.js";

describe("gate handoff", () => {
  it("accepts live_view with a URL and rejects malformed handoffs", () => {
    expect(parseHostGateContext({ handoff: { kind: "live_view", url: "https://view.test/s/1" } }).handoff).toEqual({
      kind: "live_view",
      url: "https://view.test/s/1",
    });
    for (const bad of [{ kind: "live_view" }, { kind: "live_view", url: "javascript:x" }, { kind: "other" }, "local_window"]) {
      expect(parseHostGateContext({ handoff: bad }).handoff).toBeUndefined();
    }
  });

  it("older prompts without the fields stay valid", () => {
    const prompt = tryParsePendingPrompt({ kind: "confirm", message: "ok?", id: "a" });
    expect(prompt).toEqual({ kind: "confirm", message: "ok?", id: "a" });
  });

  it("stamps local_window with host of check url, falling back to allow_domains, never a path", () => {
    expect(hostGateContextFor({ profile: "p", check: { url: "https://app.test/home" } })).toEqual({
      handoff: { kind: "local_window" },
      site: "app.test",
      profile: "p",
    });
    expect(hostGateContextFor({ allow_domains: ["*.corp.test", "b.test"] })?.site).toBe("corp.test");
    expect(hostGateContextFor(undefined)).toBeUndefined();
    expect(stampGateRequest({ kind: "confirm", handoff: { kind: "x" }, site: "evil" }, undefined)).toEqual({ kind: "confirm" });
  });
});
