import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_HOST_CAPABILITIES,
  resolveBrowserHostCapabilities,
} from "../src/browser/hostCapabilities.js";
import { createFakeLiveViewRelay } from "../src/browser/fakeLiveViewRelay.js";
import { createFakeLiveViewSource } from "../src/browser/fakeLiveViewSource.js";
import { createFakeSandboxOrchestrator } from "../src/browser/fakeSandboxOrchestrator.js";

describe("capability defaults", () => {
  it("an absent or empty record resolves to the conservative defaults", () => {
    expect(resolveBrowserHostCapabilities()).toEqual(DEFAULT_BROWSER_HOST_CAPABILITIES);
    expect(resolveBrowserHostCapabilities({})).toEqual(DEFAULT_BROWSER_HOST_CAPABILITIES);
    expect(DEFAULT_BROWSER_HOST_CAPABILITIES).toMatchObject({
      display: "headless_only",
      liveView: "none",
      viewerInput: "unsupported",
      profilePersistence: "none",
      dialogs: "unsupported",
      popups: "unsupported",
      gracefulCloseRequired: false,
      hardAllowlist: false,
      permissionPolicy: false,
    });
  });

  it("set fields override, unset and undefined fields keep defaults, unknown keys are dropped", () => {
    const resolved = resolveBrowserHostCapabilities({
      display: "virtual_display",
      liveView: undefined,
      bogus: true,
    } as never);
    expect(resolved.display).toBe("virtual_display");
    expect(resolved.liveView).toBe("none");
    expect(resolved).not.toHaveProperty("bogus");
  });

  it("does not mutate the shared defaults", () => {
    resolveBrowserHostCapabilities({ display: "local_window" });
    expect(DEFAULT_BROWSER_HOST_CAPABILITIES.display).toBe("headless_only");
  });
});

describe("fake sandbox orchestrator", () => {
  const labels = { scope: "local", runId: "r1", stageId: "s1" };

  it("lists by label and inspects", async () => {
    const o = createFakeSandboxOrchestrator();
    const a = await o.start({ labels });
    await o.start({ labels: { ...labels, runId: "r2" } });
    expect(await o.listByLabel({ runId: "r1" })).toHaveLength(1);
    expect(await o.listByLabel({ scope: "local" })).toHaveLength(2);
    expect((await o.inspect(a.ref))?.status).toBe("running");
    expect(a.ref.adapter).toEqual({ id: "fake", version: 1 });
  });

  it("graceful stop keeps the sandbox, release is idempotent", async () => {
    const o = createFakeSandboxOrchestrator();
    const a = await o.start({ labels });
    await o.stopGracefully(a.ref);
    const stopped = await o.inspect(a.ref);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.attachAddress).toBeUndefined();
    await o.release(a.ref);
    await o.release(a.ref);
    expect(o.releases).toEqual([a.ref.id]);
    expect(await o.inspect(a.ref)).toBeUndefined();
    expect(await o.listByLabel({})).toEqual([]);
  });
});

describe("fake live view relay", () => {
  const request = { runId: "r1", stageId: "s1", env: {} };

  it("replays the last frame and latest status to a late subscriber", async () => {
    const session = await createFakeLiveViewRelay().open(request);
    session.emit({ type: "frame", data: "f1" });
    session.emit({ type: "frame", data: "f2" });
    session.emit({ type: "status", data: "ok" });
    const got: unknown[] = [];
    session.subscribe((m) => got.push([m.type, m.data]));
    expect(got).toEqual([["status", "ok"], ["frame", "f2"]]);
    session.emit({ type: "frame", data: "f3" });
    expect(got.at(-1)).toEqual(["frame", "f3"]);
  });

  it("unsubscribe stops delivery; input keeps order across batches; close rejects input", async () => {
    const relay = createFakeLiveViewRelay();
    const session = await relay.open(request);
    const got: unknown[] = [];
    const off = session.subscribe((m) => got.push(m));
    off();
    session.emit({ type: "url", data: "u" });
    expect(got).toEqual([]);
    await session.sendInput([{ type: "a" }, { type: "b" }]);
    await session.sendInput([{ type: "c" }]);
    expect((relay.sessions[0]!.input).map((e) => e.type)).toEqual(["a", "b", "c"]);
    await session.close();
    expect(await session.sendInput([{ type: "d" }])).toEqual({ ok: false, reason: "closed" });
  });
});

describe("fake live view source", () => {
  it("returns an expiring address with an embed origin", async () => {
    let now = 1_000;
    const source = createFakeLiveViewSource({ ttlMs: 500, now: () => now });
    const first = await source.viewerAddress({ runId: "r", stageId: "s", sandboxId: "sbx-1" });
    expect(first.url.startsWith(first.embedOrigin)).toBe(true);
    expect(first.expiresAt).toBe(1_500);
    now = 2_000;
    const second = await source.viewerAddress({ runId: "r", stageId: "s", sandboxId: "sbx-1" });
    expect(second.expiresAt).toBe(2_500);
    expect(second.url).not.toBe(first.url);
  });
});
