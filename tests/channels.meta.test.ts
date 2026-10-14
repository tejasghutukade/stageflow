import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { CHANNEL_ERROR_INFO, channelErrorReason, channelErrorStatus } from "../src/channels/errorInfo.js";
import { channelProviders } from "../src/channels/providers.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { channelTarget, parseChannels } from "../src/channels/stageChannels.js";
import type { StageChannel } from "../src/types/stage.js";

const builtIns = channelProviders().filter(provider => provider.id !== "fake");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("provider meta", () => {
  it("covers the five providers", () => {
    expect(builtIns.map(provider => provider.id).sort()).toEqual(["agentmail", "imessage", "slack", "telegram", "whatsapp"]);
  });

  it.each(builtIns.map(provider => [provider.id, provider] as const))("%s: form fields match what the provider accepts", (_id, provider) => {
    const secretFields = provider.meta.fields.filter(field => field.target === "secret").map(field => field.key).sort();
    const accepted = [...provider.secrets.required, ...(provider.secrets.optional ?? [])].sort();
    expect(secretFields).toEqual(accepted);
    expect(provider.meta.fields.some(field => field.target === "credential")).toBe(Boolean(provider.credentialProvider));
    for (const field of provider.meta.fields) {
      expect(["config", "secret", "credential"]).toContain(field.target);
      if (field.target !== "config") expect(field.input).toBe("password");
      if (field.input === "select") expect(field.options?.length).toBeGreaterThan(0);
    }
    expect(provider.meta.label.length).toBeGreaterThan(0);
    expect(provider.meta.blurb).toMatch(/^Not connected/);
  });

  it.each(builtIns.map(provider => [provider.id, provider] as const))("%s: the connections.yaml example loads with this provider", async (_id, provider) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-meta-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), `version: 1\n${provider.meta.yamlExample}`);
    const registry = new ChannelRegistry({ cwd: root, env: {}, providers: [provider] });
    expect(registry.list().map(entry => entry.provider)).toEqual([provider.id]);
    for (const name of provider.meta.envNames) expect(provider.meta.yamlExample).toContain(`env:${name}`);
  });

  it.each(builtIns.map(provider => [provider.id, provider] as const))("%s: the stage example is a valid pinned recipient", (_id, provider) => {
    const doc = parseYaml(`channels:\n  - connection: example\n${provider.meta.stageExample}\n    operations: [send]\n`) as { channels: unknown };
    const parsed = parseChannels(doc.channels);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = provider.validateTarget(channelTarget(parsed.value[0] as StageChannel));
    expect(target.ok).toBe(true);
  });

  it.each(builtIns.map(provider => [provider.id, provider] as const))("%s: the recipient description matches the target rules", (_id, provider) => {
    const { recipient } = provider.meta;
    const list = provider.validateTarget({ to: ["a@b.test", "c@b.test"] });
    expect(list.ok === true && recipient.multiple || list.ok === false && !recipient.multiple).toBe(true);
    const cc = provider.validateTarget({ to: "a@b.test", cc: ["c@b.test"] });
    expect(cc.ok && !recipient.cc).toBe(false);
  });
});

describe("error catalogue", () => {
  it("explains every code with a reason and an HTTP status", () => {
    const codes = Object.keys(CHANNEL_ERROR_INFO);
    expect(codes.length).toBeGreaterThanOrEqual(17);
    for (const code of codes) {
      const info = CHANNEL_ERROR_INFO[code as keyof typeof CHANNEL_ERROR_INFO];
      expect(info.reason.length).toBeGreaterThan(0);
      expect(info.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("maps statuses the way the API relies on and falls back for unknown codes", () => {
    expect(channelErrorStatus("CHANNEL_INVALID_INPUT")).toBe(400);
    expect(channelErrorStatus("CHANNEL_NOT_FOUND")).toBe(404);
    expect(channelErrorStatus("CHANNEL_OPERATION_CONFLICT")).toBe(409);
    expect(channelErrorStatus("CHANNEL_RESOURCE_LIMIT")).toBe(413);
    expect(channelErrorStatus("CHANNEL_STORAGE_FAILED")).toBe(500);
    expect(channelErrorStatus("SOMETHING_ELSE")).toBe(500);
    expect(channelErrorReason("CHANNEL_AUTH_FAILED")).toBe("Credentials were rejected");
    expect(channelErrorReason("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
  });
});
