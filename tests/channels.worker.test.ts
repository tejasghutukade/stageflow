import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { channelHostFor, releaseChannelHost, workerStageChannels } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import type { StageConfig } from "../src/types/stage.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const captured = vi.hoisted(() => ({ calls: [] as { tools: string[]; customTools: { name: string }[]; systemPrompt?: string }[] }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: async (options: { tools: string[]; customTools: { name: string }[] }) => {
    captured.calls.push(options);
    throw new Error("Stop before model execution");
  } };
});

const roots: string[] = [];
let provider: ReturnType<typeof fakeChannelProvider>;
beforeEach(() => {
  provider = fakeChannelProvider();
  registerChannelProvider(provider);
  process.env.CH_TEST_TOKEN = "super-secret-token-value";
});
afterEach(async () => {
  captured.calls = [];
  unregisterChannelProvider("fake");
  delete process.env.CH_TEST_TOKEN;
  delete process.env.CH_TEST_TOKEN_FILE;
  for (const root of roots.splice(0)) { await releaseChannelHost(root); await rm(root, { recursive: true, force: true }); }
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-chworker-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), "version: 1\nconnections:\n  - id: ops\n    provider: fake\n    config: { inbox: ops@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n");
  return root;
}
const worker = fileURLToPath(new URL("./fixtures/channelStageWorker.mjs", import.meta.url));
const stage: StageConfig = { id: "notify", system_prompt: "notify", model: "model", channels: [{ connection: "ops", to: "#releases", operations: ["send"] }] } as never;

describe("worker IPC", () => {
  it("delivers through the host with the pinned target and no credentials in the worker", async () => {
    const root = await workspace();
    const launcher = new StageProcessLauncher({ cliEntry: worker, env: {
      CHANNEL_TEST_INPUT: JSON.stringify({ text: "hello", operationKey: "k" }), MODEL_TEST_SECRET: "preserved",
    } });
    expect(await launcher.launch({ rootDir: root, stageId: "notify", runId: "run-1", stage })).toEqual({ type: "succeeded" });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ target: "#releases", message: { text: "hello" }, token: "super-secret-token-value" });
  });

  it("strips the secret variable even when the launcher env carries it", async () => {
    const root = await workspace();
    const launcher = new StageProcessLauncher({ cliEntry: worker, env: {
      CHANNEL_TEST_INPUT: JSON.stringify({ text: "hello", operationKey: "k" }), MODEL_TEST_SECRET: "preserved",
      CH_TEST_TOKEN: "super-secret-token-value", CH_TEST_TOKEN_FILE: "/x",
    } });
    expect(await launcher.launch({ rootDir: root, stageId: "notify", runId: "run-1", stage })).toEqual({ type: "succeeded" });
  });

  it("rejects an undeclared channel from the worker and sends nothing", async () => {
    const root = await workspace();
    const launcher = new StageProcessLauncher({ cliEntry: worker, env: {
      CHANNEL_TEST_INPUT: JSON.stringify({ channel: "forged", text: "hello", operationKey: "k" }),
      MODEL_TEST_SECRET: "preserved", CHANNEL_EXPECT_ERROR: "CHANNEL_UNAUTHORIZED",
    } });
    expect(await launcher.launch({ rootDir: root, stageId: "notify", runId: "run-2", stage })).toEqual({ type: "succeeded" });
    expect(provider.sent).toHaveLength(0);
  });

  it("does not trust a run or stage identity supplied by the worker", async () => {
    const root = await workspace();
    const env = { CHANNEL_TEST_INPUT: JSON.stringify({ text: "hello", operationKey: "k" }), MODEL_TEST_SECRET: "preserved" };
    await new StageProcessLauncher({ cliEntry: worker, env }).launch({ rootDir: root, stageId: "notify", runId: "real-run", stage });
    expect(provider.sent[0]?.context).toMatchObject({ runId: "real-run", stageId: "notify" });
  });

  it("fails the launch before the worker starts when the connection is not defined", async () => {
    const root = await workspace();
    const bad = { ...stage, channels: [{ connection: "ghost", to: "x", operations: ["send"] }] } as never;
    const launcher = new StageProcessLauncher({ cliEntry: worker, env: { CHANNEL_TEST_INPUT: "{}", MODEL_TEST_SECRET: "preserved" } });
    expect(await launcher.launch({ rootDir: root, stageId: "notify", runId: "run-3", stage: bad })).toEqual({ type: "failed", reason: "CHANNEL_NOT_FOUND" });
    expect(provider.sent).toHaveLength(0);
  });

  it("reports an unknown outcome to a worker that disconnects mid-send", async () => {
    const previous = Object.getOwnPropertyDescriptor(process, "connected");
    const originalSend = process.send;
    Object.defineProperty(process, "connected", { value: true, configurable: true });
    process.send = (() => true) as typeof process.send;
    try {
      const listeners = process.listenerCount("message");
      const pending = workerStageChannels().send({ text: "x", operationKey: "k" });
      const outcome = expect(pending).rejects.toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN" });
      process.emit("disconnect");
      await outcome;
      expect(process.listenerCount("message")).toBe(listeners);
    } finally {
      process.send = originalSend;
      if (previous) Object.defineProperty(process, "connected", previous); else delete (process as { connected?: boolean }).connected;
    }
  });

  it("is unauthorized when there is no IPC channel", async () => {
    const previous = Object.getOwnPropertyDescriptor(process, "connected");
    Object.defineProperty(process, "connected", { value: false, configurable: true });
    try {
      await expect(workerStageChannels().send({ text: "x", operationKey: "k" })).rejects.toMatchObject({ code: "CHANNEL_UNAUTHORIZED" });
    } finally {
      if (previous) Object.defineProperty(process, "connected", previous); else delete (process as { connected?: boolean }).connected;
    }
  });
});

describe("Pi send_message registration", () => {
  async function open(config: StageConfig, withHost: boolean) {
    const root = await workspace();
    const handle = new PiAgentAdapter().openStage({
      roots: buildStageRoots(root, "notify"), stage: config as never,
      task: { id: "t", goal: "notify" }, priorEnvelope: null,
      ...(withHost ? { channels: { async send() { throw new Error("not called"); } } } : {}),
    });
    await handle.next();
    await handle.close();
    return captured.calls.at(-1)!;
  }

  it("registers send_message only when the stage declares a send channel and the host supplies channels", async () => {
    const withChannels = await open(stage, true);
    expect(withChannels.tools).toContain("send_message");
    expect(withChannels.customTools.some(tool => tool.name === "send_message")).toBe(true);
    const noHost = await open(stage, false);
    expect(noHost.tools).not.toContain("send_message");
    const noChannels = await open({ ...stage, channels: undefined } as never, true);
    expect(noChannels.tools).not.toContain("send_message");
    const noSend = await open({ ...stage, channels: [{ connection: "ops", to: "x", operations: [] }] } as never, true);
    expect(noSend.tools).not.toContain("send_message");
  });
});

describe("host construction", () => {
  it("is shared per workspace and rejects an invalid file as an error, not a crash", async () => {
    const root = await workspace();
    expect(channelHostFor(root)).toBe(channelHostFor(root));
    await releaseChannelHost(root);
    await writeFile(path.join(root, "connections.yaml"), "version: [");
    expect(() => channelHostFor(root)).toThrowError(expect.objectContaining({ code: "CHANNEL_INVALID_INPUT" }));
  });
});
