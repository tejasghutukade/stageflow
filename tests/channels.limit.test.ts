import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelError } from "../src/channels/errors.js";
import { channelHostFor, releaseChannelHost, stageChannels, validateStageChannelConnections } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { MAX_CHANNELS_PER_STAGE, parseChannels, setStageChannelLimitForTests, stageChannelLimit, validateStageChannels } from "../src/channels/stageChannels.js";
import { loadPipelineFromObjectOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { validatePipeline } from "../src/config/validateCatalog.js";
import type { StageChannel, StageConfig } from "../src/types/stage.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";

const IO = { io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } } };
const send = (connection: string, extra: Partial<StageChannel> = {}): StageChannel => ({ connection, to: "#general", operations: ["send"], ...extra });
const stage = (extra: Record<string, unknown> = {}) => ({ id: "a", system_prompt: "hi", model: "anthropic/claude-sonnet-4-5", ...IO, ...extra });

const roots: string[] = [];
beforeEach(() => {
  registerChannelProvider(fakeChannelProvider());
  process.env.CH_TEST_TOKEN = "super-secret-token-value";
});
afterEach(async () => {
  unregisterChannelProvider("fake");
  delete process.env.CH_TEST_TOKEN;
  for (const root of roots.splice(0)) { await releaseChannelHost(root); await rm(root, { recursive: true, force: true }); }
});
const connections = ["ops", "mail"].map(id => `  - id: ${id}\n    provider: fake\n    config: { inbox: ${id}@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }`).join("\n");
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-limit-"));
  roots.push(root);
  await writeFile(path.join(root, "connections.yaml"), `version: 1\nconnections:\n${connections}\n`);
  return root;
}

describe("one channel per stage", () => {
  it("is the shipped policy, and one flag away from several", () => {
    expect(MAX_CHANNELS_PER_STAGE).toBe(1);
    expect(stageChannelLimit()).toBe(1);
    const restore = setStageChannelLimitForTests(3);
    try {
      expect(parseChannels([send("ops"), send("mail")]).ok).toBe(true);
    } finally {
      restore();
    }
    expect(stageChannelLimit()).toBe(1);
  });

  it("accepts a single channel and rejects a second, with a message that says what to do", () => {
    expect(parseChannels([send("ops")]).ok).toBe(true);
    const two = parseChannels([send("ops"), send("mail")]);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.message).toMatch(/one channel.*split the work into separate stages/);
  });

  it("rejects two entries for the same connection even with different aliases", () => {
    expect(parseChannels([send("ops", { alias: "a" }), send("ops", { alias: "b" })].map(entry => entry)).ok).toBe(false);
  });

  it("rejects two channels on a stage file and on an inline stage", async () => {
    const root = await project();
    const file = path.join(root, "a.yaml");
    await writeFile(file, [
      "id: a", "system_prompt: hi", "model: anthropic/claude-sonnet-4-5",
      "io: { input: { schema: { type: object } }, output: { schema: { type: object } } }",
      "channels:", "  - connection: ops", "    to: '#general'", "    operations: [send]",
      "  - connection: mail", "    to: '#general'", "    operations: [send]", "",
    ].join("\n"));
    const fromFile = await loadStageOutcome(file);
    expect(fromFile.ok).toBe(false);
    if (!fromFile.ok) expect(fromFile.issues[0]?.code).toBe("stage.invalid_channels");
    const inline = await loadPipelineFromObjectOutcome({ id: "p", stages: [stage({ channels: [send("ops"), send("mail")] })] });
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.issues[0]?.code).toBe("stage.invalid_channels");
  });

  it("catches a second channel that only appears after merging the pipeline default", async () => {
    const merged = await loadPipelineFromObjectOutcome({ id: "p", channels: [send("ops")], stages: [stage({ channels: [send("mail")] })] });
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.issues[0]?.code).toBe("stage.invalid_channels");
      expect(merged.issues[0]?.message).toMatch(/channels: \[\]/);
    }
  });

  it("still allows each legitimate shape", async () => {
    const ok = async (raw: object) => (await loadPipelineFromObjectOutcome(raw as never)).ok;
    expect(await ok({ id: "p", channels: [send("ops")], stages: [stage()] })).toBe(true);
    expect(await ok({ id: "p", stages: [stage({ channels: [send("ops")] })] })).toBe(true);
    expect(await ok({ id: "p", channels: [send("ops")], stages: [stage({ channels: [] })] })).toBe(true);
    expect(await ok({ id: "p", channels: [send("ops")], stages: [stage({ channels: [send("ops", { to: "#other" })] })] })).toBe(true);
    expect(await ok({ id: "p", stages: [stage()] })).toBe(true);
  });

  it("one connection can still notify several recipients through its own target list", () => {
    expect(parseChannels([{ connection: "mail", to: ["a@b.test", "c@b.test"], cc: ["d@b.test"], operations: ["send"] }]).ok).toBe(true);
  });

  it("static validation refuses a stage object that skipped parsing", async () => {
    const root = await project();
    const host = channelHostFor(root);
    const sneaky: StageConfig = { id: "a", system_prompt: "x", channels: [send("ops"), send("mail")] };
    const issues = validateStageChannels(host.registry, sneaky);
    expect(issues[0]).toMatchObject({ code: "CHANNEL_INVALID_INPUT" });
    expect(issues[0]!.message).toMatch(/one channel/);
    expect(() => validateStageChannelConnections(host, sneaky)).toThrow("CHANNEL_INVALID_INPUT");
    expect(validateStageChannels(host.registry, { id: "a", system_prompt: "x", channels: [send("ops")] })).toEqual([]);
  });

  it("sf validate rejects a pipeline file whose stage declares two", async () => {
    const root = await project();
    const lines = [
      "id: p", "stages:", "  - id: a", "    system_prompt: hi", "    model: anthropic/claude-sonnet-4-5",
      "    io: { input: { schema: { type: object } }, output: { schema: { type: object } } }",
      "    channels:", "      - connection: ops", "        to: '#general'", "        operations: [send]",
      "      - connection: mail", "        to: '#general'", "        operations: [send]", "",
    ];
    await writeFile(path.join(root, "p.pipeline.yaml"), lines.join("\n"));
    const result = await validatePipeline(path.join(root, "p.pipeline.yaml"), { cwd: root, projectRoot: root, channelProviders: [fakeChannelProvider()] });
    expect(result.ok).toBe(false);
    expect(result.findings.some(finding => finding.severity === "error" && /one channel/.test(finding.message))).toBe(true);
  });

  it("the send path refuses to run for a stage that declares two, even if everything upstream was bypassed", async () => {
    const root = await project();
    const host = channelHostFor(root);
    const channels = stageChannels(host, { id: "a", system_prompt: "x", channels: [send("ops"), send("mail")] }, "run-1");
    for (const channel of ["ops", "mail", undefined]) {
      await expect(channels.send({ channel, text: "hi", operationKey: "k" })).rejects.toBeInstanceOf(ChannelError);
    }
    const one = stageChannels(host, { id: "a", system_prompt: "x", channels: [send("ops")] }, "run-1");
    await expect(one.send({ text: "hi", operationKey: "k" })).resolves.toMatchObject({ channel: "ops" });
  });
});
