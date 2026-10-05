import { describe, expect, it } from "vitest";
import {
  hostGateContextFor,
  parseHostGateContext,
  stampGateRequest,
} from "../src/browser/gateHandoff.js";
import { humanLoginPromptBlock } from "../src/browser/humanLogin.js";
import { tryParsePendingPrompt } from "../src/runtime/stageHitl.js";

const desktop = {
  runId: "r1",
  stageId: "login",
  capabilities: { display: "local_window", liveView: "none" },
} as const;

describe("gate handoff", () => {
  it("stamps a tokenless root-relative live_view path for virtual displays", () => {
    const context = hostGateContextFor(
      { profile: "p" },
      { runId: "run 1", stageId: "a/b", capabilities: { display: "virtual_display", liveView: "relay" } },
    );
    expect(context?.handoff).toEqual({ kind: "live_view", url: "/api/runs/run%201/stages/a%2Fb/live-view" });
    expect(context?.profile).toBe("p");
  });

  it("stamps live_view for headless_only with a provider view, and nothing without a live view", () => {
    expect(
      hostGateContextFor({}, { ...desktop, capabilities: { display: "headless_only", liveView: "provider_view" } })?.handoff?.kind,
    ).toBe("live_view");
    expect(
      hostGateContextFor({}, { ...desktop, capabilities: { display: "headless_only", liveView: "none" } })?.handoff,
    ).toBeUndefined();
  });

  it("a local window wins over a live view", () => {
    expect(
      hostGateContextFor({}, { ...desktop, capabilities: { display: "local_window", liveView: "relay" } })?.handoff,
    ).toEqual({ kind: "local_window" });
  });

  it("overwrites an agent-forged handoff", () => {
    const context = hostGateContextFor({}, desktop);
    expect(
      stampGateRequest({ kind: "confirm", handoff: { kind: "live_view", url: "https://evil.test/" } }, context),
    ).toMatchObject({ handoff: { kind: "local_window" } });
  });

  it("accepts root-relative live_view paths and rejects unsafe urls", () => {
    for (const url of ["/api/runs/r/stages/s/live-view", "https://view.test/x", "http://view.test/x"]) {
      expect(parseHostGateContext({ handoff: { kind: "live_view", url } }).handoff).toEqual({ kind: "live_view", url });
    }
    for (const url of ["//evil.test/x", "/\\evil.test", "javascript:alert(1)", "ftp://x.test/a", "api/runs/r", ""]) {
      expect(parseHostGateContext({ handoff: { kind: "live_view", url } }).handoff).toBeUndefined();
    }
  });

  it("login prompt block differs by handoff kind", () => {
    expect(humanLoginPromptBlock("https://a.test/login")).toContain("visible browser window on the operator's screen");
    expect(humanLoginPromptBlock("https://a.test/login", "local_window")).toBe(humanLoginPromptBlock("https://a.test/login"));
    const live = humanLoginPromptBlock("https://a.test/login", "live_view");
    expect(live).toContain("through the live view shown in the console");
    expect(live).toContain("ask_operator with kind confirm");
    expect(live).toContain("Leave the browser open");
    expect(live).not.toContain("visible browser window");
  });

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
    expect(hostGateContextFor({ profile: "p", check: { url: "https://app.test/home" } }, desktop)).toEqual({
      handoff: { kind: "local_window" },
      site: "app.test",
      profile: "p",
    });
    expect(hostGateContextFor({ allow_domains: ["*.corp.test", "b.test"] }, desktop)?.site).toBe("corp.test");
    expect(hostGateContextFor(undefined, desktop)).toBeUndefined();
    expect(stampGateRequest({ kind: "confirm", handoff: { kind: "x" }, site: "evil" }, undefined)).toEqual({ kind: "confirm" });
  });
});
