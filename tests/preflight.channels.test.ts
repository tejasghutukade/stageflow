import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipelineFromObject } from "../src/config/loadPipeline.js";
import { preflightFailureCode, runPipelinePreflight } from "../src/preflight/pipelinePreflight.js";
import { checkStageChannels } from "../src/preflight/channelChecks.js";
import type { ConnectionHealth } from "../src/channels/types.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";
import { setStageChannelLimitForTests } from "../src/channels/stageChannels.js";

let restoreChannelLimit: () => void;
beforeEach(() => { restoreChannelLimit = setStageChannelLimitForTests(20); });
afterEach(() => restoreChannelLimit());

const roots: string[] = [];
beforeEach(() => { process.env.CH_TEST_TOKEN = "super-secret-token-value"; });
afterEach(async () => {
  delete process.env.CH_TEST_TOKEN;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const IO = { io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } } };
const connectionsYaml = (...ids: string[]) => `version: 1\nconnections:\n${ids.map(id => `  - id: ${id}\n    provider: fake\n    config: { inbox: ${id}@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n`).join("")}`;

async function setup(opts: { connections?: string[]; channels?: Array<[string, string]>; providerOptions?: Parameters<typeof fakeChannelProvider>[0] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-prechannels-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), connectionsYaml(...(opts.connections ?? ["ops", "mail"])));
  const channels = opts.channels ?? [["ops", "#general"]];
  const loaded = await loadPipelineFromObject({
    id: "p",
    stages: [
      { id: "a", entry: true, route: [{ to: "b" }], system_prompt: "x", model: "anthropic/claude-sonnet-4-5", ...IO,
        channels: channels.map(([connection, to], i) => ({ connection, to, operations: ["send"], alias: `c${i}` })) },
      { id: "b", system_prompt: "x", model: "anthropic/claude-sonnet-4-5", ...IO,
        channels: channels.map(([connection, to], i) => ({ connection, to, operations: ["send"], alias: `c${i}` })) },
    ],
  } as never);
  const provider = fakeChannelProvider(opts.providerOptions);
  return { root, loaded, provider };
}
const fail = (code: ConnectionHealth["error"] extends infer E ? NonNullable<E>["code"] : never, retryable: boolean) => (): ConnectionHealth =>
  ({ state: "failed", checkedAt: new Date().toISOString(), error: { code, retryable } });
const ok = (): ConnectionHealth => ({ state: "ok", checkedAt: new Date().toISOString() });
const fast = { retryDelaysMs: [1, 1] as const, attemptTimeoutMs: 200 };

describe("channel preflight", () => {
  it("adds nothing when no stage declares channels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-prechannels-"));
    roots.push(root);
    const loaded = await loadPipelineFromObject({ id: "p", stages: [{ id: "a", system_prompt: "x", model: "anthropic/claude-sonnet-4-5", ...IO }] } as never);
    expect(await checkStageChannels(loaded, { projectRoot: root, providers: [] })).toEqual([]);
  });

  it("passes when the connection is healthy, checking each connection once", async () => {
    const { root, loaded, provider } = await setup();
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items).toEqual([{ kind: "channel", status: "ok", connection: "ops" }]);
    expect(provider.checkCalls).toBe(1);
  });

  it("checks several connections in parallel and reports each", async () => {
    const { root, loaded, provider } = await setup({ channels: [["ops", "#a"], ["mail", "#b"]] });
    provider.checkQueue.push(ok, fail("CHANNEL_AUTH_FAILED", false));
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items.map(i => [i.connection, i.status])).toEqual([["ops", "ok"], ["mail", "channel_check_failed"]]);
  });

  it("retries a transient failure and passes when it recovers", async () => {
    const { root, loaded, provider } = await setup();
    provider.checkQueue.push(fail("CHANNEL_CONNECTION_FAILED", true), fail("CHANNEL_RATE_LIMIT", true), ok);
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]?.status).toBe("ok");
    expect(provider.checkCalls).toBe(3);
  });

  it("gives up after two retries on a persistent transient failure", async () => {
    const { root, loaded, provider } = await setup();
    provider.checkQueue.push(fail("CHANNEL_CONNECTION_FAILED", true), fail("CHANNEL_CONNECTION_FAILED", true), fail("CHANNEL_CONNECTION_FAILED", true), ok);
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_CONNECTION_FAILED", retryable: true });
    expect(provider.checkCalls).toBe(3);
  });

  it.each(["CHANNEL_AUTH_FAILED", "CHANNEL_UNAUTHORIZED", "CHANNEL_INVALID_INPUT", "CHANNEL_TARGET_INVALID"] as const)("does not retry %s", async code => {
    const { root, loaded, provider } = await setup();
    provider.checkQueue.push(fail(code, false), ok);
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: code, retryable: false });
    expect(provider.checkCalls).toBe(1);
  });

  it("treats a hung check as a retryable timeout", async () => {
    const { root, loaded, provider } = await setup();
    provider.checkQueue.push(() => new Promise<ConnectionHealth>(() => undefined), () => new Promise<ConnectionHealth>(() => undefined), () => new Promise<ConnectionHealth>(() => undefined));
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], retryDelaysMs: [1, 1], attemptTimeoutMs: 20 });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_TIMEOUT", retryable: true });
    expect(provider.checkCalls).toBe(3);
  });

  it("maps a provider that throws to a failed check without leaking the error text", async () => {
    const { root, loaded, provider } = await setup();
    provider.checkQueue.push(() => { throw new Error("401 token super-secret-token-value"); });
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_CONNECTION_FAILED", retryable: false });
    expect(JSON.stringify(items)).not.toContain("super-secret");
  });

  it("reports a missing secret as a failed check naming no value", async () => {
    const { root, loaded, provider } = await setup();
    delete process.env.CH_TEST_TOKEN;
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_SECRET_UNAVAILABLE" });
    expect(provider.checkCalls).toBe(0);
  });

  it("reports every connection when connections.yaml cannot be loaded", async () => {
    const { root, loaded, provider } = await setup();
    await writeFile(path.join(root, "connections.yaml"), "version: [");
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items).toEqual([expect.objectContaining({ connection: "ops", status: "channel_check_failed", channelCode: "CHANNEL_INVALID_INPUT" })]);
  });

  it("checks pinned targets after the connection passes and deduplicates them across stages", async () => {
    const { root, loaded, provider } = await setup({ channels: [["ops", "#a"], ["ops", "#b"]], providerOptions: { withTargetCheck: true } });
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(items[0]?.status).toBe("ok");
    expect(provider.targetChecks).toHaveLength(1);
    expect(provider.targetChecks[0]?.targets).toEqual(["#a", "#b"]);
  });

  it("fails the connection when a pinned target is rejected, and skips target checks when the connection fails", async () => {
    const rejected = await setup({ providerOptions: { withTargetCheck: true } });
    rejected.provider.targetHealth = "failed";
    expect((await checkStageChannels(rejected.loaded, { projectRoot: rejected.root, providers: [rejected.provider], ...fast }))[0])
      .toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_RECIPIENT_REJECTED" });
    const down = await setup({ providerOptions: { withTargetCheck: true } });
    down.provider.checkQueue.push(fail("CHANNEL_AUTH_FAILED", false));
    await checkStageChannels(down.loaded, { projectRoot: down.root, providers: [down.provider], ...fast });
    expect(down.provider.targetChecks).toHaveLength(0);
  });

  it("never echoes targets in an item", async () => {
    const { root, loaded, provider } = await setup({ channels: [["ops", "+15551234567"]], providerOptions: { withTargetCheck: true } });
    provider.targetHealth = "failed";
    const items = await checkStageChannels(loaded, { projectRoot: root, providers: [provider], ...fast });
    expect(JSON.stringify(items)).not.toContain("5551234567");
  });
});

describe("runPipelinePreflight with channels", () => {
  it("fails the preflight with channel_check_failed and a stable failure code", async () => {
    const { root, loaded, provider } = await setup();
    provider.health = "failed";
    const result = await runPipelinePreflight(loaded, { projectRoot: root, forStart: true, channels: { providers: [provider], ...fast } });
    expect(result.ok).toBe(false);
    expect(result.checks.find(c => c.kind === "channel")).toMatchObject({ status: "channel_check_failed", connection: "ops", channelCode: "CHANNEL_AUTH_FAILED" });
    expect(preflightFailureCode(result, { forStart: true })).toBe("channel_check_failed");
  });

  it("passes when channels are healthy and leaves other checks alone", async () => {
    const { root, loaded, provider } = await setup();
    const result = await runPipelinePreflight(loaded, { projectRoot: root, forStart: true, channels: { providers: [provider], ...fast } });
    expect(result.ok).toBe(true);
    expect(result.checks.filter(c => c.kind === "channel")).toEqual([{ kind: "channel", status: "ok", connection: "ops" }]);
  });
});

describe("channelFailureSummary", () => {
  it("names each failed connection with a plain reason and its code, and ignores the rest", async () => {
    const { channelFailureSummary } = await import("../src/preflight/channelChecks.js");
    const checks = [
      { kind: "channel", status: "ok", connection: "mail" },
      { kind: "channel", status: "channel_check_failed", connection: "phone", channelCode: "CHANNEL_RECIPIENT_REJECTED" },
      { kind: "channel", status: "channel_check_failed", connection: "odd", channelCode: "CHANNEL_SOMETHING_NEW" },
      { kind: "toolchain", status: "missing_tool", tool: "git" },
    ] as never[];
    const text = channelFailureSummary(checks)!;
    expect(text).toContain("phone: The provider will not message this recipient");
    expect(text).toContain("(CHANNEL_RECIPIENT_REJECTED)");
    expect(text).toContain("odd: CHANNEL_SOMETHING_NEW (CHANNEL_SOMETHING_NEW)");
    expect(text).not.toContain("mail");
    expect(channelFailureSummary([{ kind: "channel", status: "ok", connection: "mail" } as never])).toBeUndefined();
  });
});
