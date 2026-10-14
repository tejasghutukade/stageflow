import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ChannelHealthMonitor } from "../src/channels/health.js";
import type { ConnectionHealth } from "../src/channels/types.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const roots: string[] = [];
beforeEach(() => { process.env.CH_TEST_TOKEN = "super-secret-token-value"; });
afterEach(async () => {
  vi.useRealTimers();
  delete process.env.CH_TEST_TOKEN;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(extra = "") {
  const root = await mkdtemp(path.join(tmpdir(), "sf-health-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), `version: 1\nconnections:\n  - id: ops\n    provider: fake\n    config: { inbox: a@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n${extra}`);
  const provider = fakeChannelProvider();
  const registry = new ChannelRegistry({ cwd: root, providers: [provider] });
  return { provider, registry };
}
const failure = (): ConnectionHealth => ({ state: "failed", checkedAt: new Date().toISOString(), error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });

describe("ChannelHealthMonitor", () => {
  it("checks on start, then on the interval, and keeps the last result", async () => {
    vi.useFakeTimers();
    const { provider, registry } = await setup();
    const monitor = new ChannelHealthMonitor({ registry, intervalMs: 1000, jitter: 0, random: () => 0 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.checkCalls).toBe(1);
    expect(monitor.snapshot().ops?.state).toBe("ok");
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.checkCalls).toBe(2);
    await monitor.stop();
  });

  it("backs off after failures up to the cap and returns to the interval after a success", async () => {
    vi.useFakeTimers();
    const { provider, registry } = await setup();
    provider.checkQueue.push(failure, failure, failure, failure);
    const monitor = new ChannelHealthMonitor({ registry, intervalMs: 1000, jitter: 0, maxBackoffFactor: 4, random: () => 0 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.checkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1998);
    expect(provider.checkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.checkCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(provider.checkCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(provider.checkCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(4000);
    expect(provider.checkCalls).toBe(5);
    expect(monitor.snapshot().ops?.state).toBe("ok");
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider.checkCalls).toBe(6);
    await monitor.stop();
  });

  it("applies jitter within the configured fraction", async () => {
    vi.useFakeTimers();
    const { provider, registry } = await setup();
    const monitor = new ChannelHealthMonitor({ registry, intervalMs: 1000, jitter: 0.5, random: () => 1 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(provider.checkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(provider.checkCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.checkCalls).toBe(2);
    await monitor.stop();
  });

  it("skips disabled connections and stops cleanly", async () => {
    vi.useFakeTimers();
    const { provider, registry } = await setup("  - id: off\n    provider: fake\n    enabled: false\n    config: { inbox: z }\n    secrets: { token: env:CH_TEST_TOKEN }\n");
    const monitor = new ChannelHealthMonitor({ registry, intervalMs: 1000, jitter: 0, random: () => 0 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(Object.keys(monitor.snapshot())).toEqual(["ops"]);
    await monitor.stop();
    const calls = provider.checkCalls;
    await vi.advanceTimersByTimeAsync(10000);
    expect(provider.checkCalls).toBe(calls);
  });

  it("records a code, never provider error text, when a check throws or hangs", async () => {
    vi.useFakeTimers();
    const { provider, registry } = await setup();
    provider.checkQueue.push(() => { throw new Error("401 super-secret-token-value"); });
    const monitor = new ChannelHealthMonitor({ registry, timeoutMs: 100 });
    const thrown = await monitor.checkNow("ops");
    expect(thrown).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: false } });
    provider.checkQueue.push(() => new Promise<ConnectionHealth>(() => undefined));
    const pending = monitor.checkNow("ops");
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ error: { code: "CHANNEL_TIMEOUT", retryable: true } });
    expect(JSON.stringify(monitor.snapshot())).not.toContain("super-secret");
  });

  it("reports a missing secret as a failed check", async () => {
    const { registry } = await setup();
    delete process.env.CH_TEST_TOKEN;
    const monitor = new ChannelHealthMonitor({ registry });
    expect(await monitor.checkNow("ops")).toMatchObject({ state: "failed", error: { code: "CHANNEL_SECRET_UNAVAILABLE" } });
  });

  it("notifies a listener and returns copies", async () => {
    const { registry } = await setup();
    const seen: string[] = [];
    const monitor = new ChannelHealthMonitor({ registry, onResult: (id, health) => seen.push(`${id}:${health.state}`) });
    const result = await monitor.checkNow("ops");
    result.state = "failed";
    expect(seen).toEqual(["ops:ok"]);
    expect(monitor.snapshot().ops?.state).toBe("ok");
  });
});
