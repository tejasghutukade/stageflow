import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelError } from "../src/channels/errors.js";
import {
  channelHostFor, channelsWorkerEnvironment, releaseChannelHost, stageChannels, validateStageChannelConnections,
} from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import type { StageConfig } from "../src/types/stage.js";
import { createSendMessageTool } from "../src/tools/sendMessage.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const roots: string[] = [];
let provider: ReturnType<typeof fakeChannelProvider>;
beforeEach(() => {
  provider = fakeChannelProvider();
  registerChannelProvider(provider);
  process.env.CH_TEST_TOKEN = "super-secret-token-value";
});
afterEach(async () => {
  unregisterChannelProvider("fake");
  delete process.env.CH_TEST_TOKEN;
  for (const root of roots.splice(0)) { await releaseChannelHost(root); await rm(root, { recursive: true, force: true }); }
});

const connections = `version: 1
connections:
  - id: ops
    provider: fake
    config: { inbox: ops@b.test }
    secrets: { token: env:CH_TEST_TOKEN }
  - id: mail
    provider: fake
    config: { inbox: mail@b.test }
    secrets: { token: env:CH_TEST_TOKEN }
  - id: off
    provider: fake
    enabled: false
    config: { inbox: off@b.test }
    secrets: { token: env:CH_TEST_TOKEN }
`;
async function setup(yaml = connections) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-chhost-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), yaml);
  return { root, host: channelHostFor(root) };
}
const stage = (channels: StageConfig["channels"]): StageConfig => ({ id: "notify", system_prompt: "x", channels });
const ch = (connection: string, to = "#general", extra: Record<string, unknown> = {}) => ({ connection, to, operations: ["send" as const], ...extra });
async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return error instanceof ChannelError ? error.code : `other:${String(error)}`; }
  return undefined;
}

describe("stageChannels", () => {
  it("sends to the target pinned in the stage and returns a receipt without internals", async () => {
    const { host } = await setup();
    const out = await stageChannels(host, stage([ch("ops", "#releases")]), "run-1").send({ text: "hi", subject: "s", operationKey: "k" });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ connectionId: "ops", target: "#releases", message: { text: "hi", subject: "s" } });
    expect(out).toMatchObject({ channel: "ops", connection: "ops", providerMessageId: "fake-1" });
    expect(JSON.stringify(out)).not.toContain("#releases");
  });

  it("hands the provider resolved secrets but never exposes them in the receipt", async () => {
    const { host } = await setup();
    const out = await stageChannels(host, stage([ch("ops")]), "r").send({ text: "hi", operationKey: "k" });
    expect(provider.sent[0]?.token).toBe("super-secret-token-value");
    expect(JSON.stringify(out)).not.toContain("super-secret");
  });

  it("rejects a channel the stage did not declare", async () => {
    const { host } = await setup();
    const s = stageChannels(host, stage([ch("ops")]), "r");
    expect(await code(s.send({ channel: "mail", text: "x", operationKey: "k" }))).toBe("CHANNEL_UNAUTHORIZED");
    expect(provider.sent).toHaveLength(0);
  });

  it("requires a channel name when several are declared and picks by alias or connection", async () => {
    const { host } = await setup();
    const s = stageChannels(host, stage([ch("ops", "#a", { alias: "alpha" }), ch("mail", "#b")]), "r");
    expect(await code(s.send({ text: "x", operationKey: "k" }))).toBe("CHANNEL_INVALID_INPUT");
    await s.send({ channel: "alpha", text: "x", operationKey: "k1" });
    await s.send({ channel: "mail", text: "y", operationKey: "k2" });
    expect(provider.sent.map(x => [x.connectionId, x.target])).toEqual([["ops", "#a"], ["mail", "#b"]]);
    expect(await code(s.send({ channel: "ops", text: "x", operationKey: "k3" }))).toBe("CHANNEL_UNAUTHORIZED");
  });

  it("does not let the caller choose a target", async () => {
    const { host } = await setup();
    const s = stageChannels(host, stage([ch("ops", "#fixed")]), "r");
    expect(await code(s.send({ text: "x", operationKey: "k", to: "#evil" } as never))).toBe("CHANNEL_INVALID_INPUT");
    expect(provider.sent).toHaveLength(0);
  });

  it.each([
    ["empty text", { text: "", operationKey: "k" }],
    ["oversized text", { text: "x".repeat(65537), operationKey: "k" }],
    ["subject with a newline", { text: "x", subject: "a\nb", operationKey: "k" }],
    ["missing key", { text: "x" }],
    ["overlong key", { text: "x", operationKey: "k".repeat(121) }],
  ])("rejects %s before anything is sent", async (_n, input) => {
    const { host } = await setup();
    expect(await code(stageChannels(host, stage([ch("ops")]), "r").send(input as never))).toBe("CHANNEL_INVALID_INPUT");
    expect(provider.sent).toHaveLength(0);
  });

  it("refuses a disabled connection and an operation the stage did not request", async () => {
    const { host } = await setup();
    expect(await code(stageChannels(host, stage([ch("off")]), "r").send({ text: "x", operationKey: "k" }))).toBe("CHANNEL_DISABLED");
    const none = stage([{ ...ch("ops"), operations: [] as never }]);
    expect(await code(stageChannels(host, none, "r").send({ text: "x", operationKey: "k" }))).toBe("CHANNEL_UNAUTHORIZED");
    expect(provider.sent).toHaveLength(0);
  });

  it("reports a missing secret without naming a value", async () => {
    const { host } = await setup();
    delete process.env.CH_TEST_TOKEN;
    expect(await code(stageChannels(host, stage([ch("ops")]), "r").send({ text: "x", operationKey: "k" }))).toBe("CHANNEL_SECRET_UNAVAILABLE");
  });

  it("freezes the declared channels at construction", async () => {
    const { host } = await setup();
    const config = stage([ch("ops", "#one")]);
    const s = stageChannels(host, config, "r");
    config.channels![0]!.to = "#two";
    await s.send({ text: "x", operationKey: "k" });
    expect(provider.sent[0]?.target).toBe("#one");
  });
});

describe("idempotency", () => {
  it("sends once for a repeated operation key and again for a new one", async () => {
    const { host } = await setup();
    const s = stageChannels(host, stage([ch("ops")]), "r");
    const a = await s.send({ text: "hi", operationKey: "k" });
    const b = await s.send({ text: "hi", operationKey: "k" });
    expect(provider.sent).toHaveLength(1);
    expect(b).toEqual(a);
    await s.send({ text: "hi", operationKey: "k2" });
    expect(provider.sent).toHaveLength(2);
  });

  it("refuses the same key with different content", async () => {
    const { host } = await setup();
    const s = stageChannels(host, stage([ch("ops")]), "r");
    await s.send({ text: "hi", operationKey: "k" });
    expect(await code(s.send({ text: "different", operationKey: "k" }))).toBe("CHANNEL_OPERATION_CONFLICT");
  });

  it("binds keys to the run, the stage, and the channel", async () => {
    const { host } = await setup();
    const channels = [ch("ops", "#a", { alias: "x" }), ch("mail", "#b", { alias: "y" })];
    await stageChannels(host, stage(channels), "run-1").send({ channel: "x", text: "hi", operationKey: "k" });
    await stageChannels(host, stage(channels), "run-1").send({ channel: "y", text: "hi", operationKey: "k" });
    await stageChannels(host, stage(channels), "run-2").send({ channel: "x", text: "hi", operationKey: "k" });
    await stageChannels(host, { ...stage(channels), id: "other" }, "run-1").send({ channel: "x", text: "hi", operationKey: "k" });
    expect(provider.sent).toHaveLength(4);
  });

  it("does not resend after an unknown outcome, even for a new process", async () => {
    const { root, host } = await setup();
    provider.failWith = new Error("connection reset");
    const s = stageChannels(host, stage([ch("ops")]), "r");
    expect(await code(s.send({ text: "hi", operationKey: "k" }))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    provider.failWith = undefined;
    expect(await code(s.send({ text: "hi", operationKey: "k" }))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    await releaseChannelHost(root);
    const again = stageChannels(channelHostFor(root), stage([ch("ops")]), "r");
    expect(await code(again.send({ text: "hi", operationKey: "k" }))).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect(provider.sent).toHaveLength(0);
  });

  it("never leaks a provider's error text", async () => {
    const { host } = await setup();
    provider.failWith = new Error("401 for token super-secret-token-value");
    try { await stageChannels(host, stage([ch("ops")]), "r").send({ text: "hi", operationKey: "k" }); } catch (error) {
      expect(JSON.stringify(error) + String(error) + String((error as Error).stack)).not.toContain("super-secret-token-value");
    }
  });
});

describe("validateStageChannelConnections", () => {
  it("passes for a valid declaration and throws the first problem otherwise", async () => {
    const { host } = await setup();
    expect(() => validateStageChannelConnections(host, stage([ch("ops")]))).not.toThrow();
    expect(() => validateStageChannelConnections(host, stage([ch("ghost")]))).toThrowError(expect.objectContaining({ code: "CHANNEL_NOT_FOUND" }));
    expect(() => validateStageChannelConnections(host, stage([ch("off")]))).toThrowError(expect.objectContaining({ code: "CHANNEL_DISABLED" }));
    expect(() => validateStageChannelConnections(host, stage([ch("ops", "")]))).toThrowError(expect.objectContaining({ code: "CHANNEL_TARGET_INVALID" }));
  });
});

describe("channelsWorkerEnvironment", () => {
  it("removes referenced secrets and their _FILE form and leaves everything else", async () => {
    const { root } = await setup();
    const env = channelsWorkerEnvironment({ CH_TEST_TOKEN: "s", CH_TEST_TOKEN_FILE: "/x", KEEP: "1", PATH: "/bin" }, root);
    expect(env).toEqual({ KEEP: "1", PATH: "/bin" });
  });

  it("covers credentials and leaves the environment unchanged when the file is unreadable", async () => {
    const { root } = await setup("version: 1\ncredentials:\n  - id: p\n    provider: photon\n    secrets: { projectSecret: env:PHOTON_SECRET }\n");
    expect(channelsWorkerEnvironment({ PHOTON_SECRET: "s", KEEP: "1" }, root)).toEqual({ KEEP: "1" });
    await writeFile(path.join(root, "connections.yaml"), "version: [");
    expect(channelsWorkerEnvironment({ PHOTON_SECRET: "s" }, root)).toEqual({ PHOTON_SECRET: "s" });
  });

  it("is a no-op without a connections file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-chhost-"));
    roots.push(root);
    expect(channelsWorkerEnvironment({ A: "1" }, root)).toEqual({ A: "1" });
  });
});

describe("send_message tool", () => {
  it("returns the receipt as JSON and errors with only a code", async () => {
    const { host } = await setup();
    const tool = createSendMessageTool(stageChannels(host, stage([ch("ops")]), "r"));
    const ok = await tool.execute("id", { text: "hi", operationKey: "k" });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ channel: "ops", providerMessageId: "fake-1" });
    const bad = await tool.execute("id", { channel: "ghost", text: "hi", operationKey: "k2" });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]!.text)).toEqual({ code: "CHANNEL_UNAUTHORIZED", retryable: false });
    const unexpected = await createSendMessageTool({ async send() { throw new TypeError("boom with secret"); } }).execute("id", {});
    expect(JSON.parse(unexpected.content[0]!.text)).toEqual({ code: "CHANNEL_CONNECTION_FAILED", retryable: false });
  });
});
