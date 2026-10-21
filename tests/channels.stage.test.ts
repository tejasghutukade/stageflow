import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipelineFromObjectOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { validatePipeline } from "../src/config/validateCatalog.js";
import { channelKey, mergeChannelDefaults, parseChannels } from "../src/channels/stageChannels.js";
import type { StageChannel } from "../src/types/stage.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";
import { setStageChannelLimitForTests } from "../src/channels/stageChannels.js";

let restoreChannelLimit: () => void;
beforeEach(() => { restoreChannelLimit = setStageChannelLimitForTests(20); });
afterEach(() => restoreChannelLimit());

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-channels-stage-"));
  roots.push(root);
  return root;
}

const IO = { io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } } };
const send = (connection: string, to: string | string[] = "#general", extra: Partial<StageChannel> = {}): StageChannel =>
  ({ connection, to, operations: ["send"], ...extra });

describe("parseChannels", () => {
  it("accepts entries with alias, list targets and cc", () => {
    const out = parseChannels([
      { alias: "releases", connection: "ops-slack", to: "#releases", operations: ["send"] },
      { connection: "support", to: ["a@x.test", "b@x.test"], cc: ["c@x.test"], operations: ["send"] },
    ]);
    expect(out.ok).toBe(true);
  });

  it.each([
    ["not a list", { connection: "a" }],
    ["missing operations", [{ connection: "a", to: "x" }]],
    ["empty operations", [{ connection: "a", to: "x", operations: [] }]],
    ["unsupported operation", [{ connection: "a", to: "x", operations: ["receive"] }]],
    ["missing to", [{ connection: "a", operations: ["send"] }]],
    ["empty to list", [{ connection: "a", to: [], operations: ["send"] }]],
    ["empty target string", [{ connection: "a", to: "", operations: ["send"] }]],
    ["unknown key", [{ connection: "a", to: "x", operations: ["send"], token: "t" }]],
    ["bad connection id", [{ connection: "-a", to: "x", operations: ["send"] }]],
    ["bad alias", [{ alias: "has space", connection: "a", to: "x", operations: ["send"] }]],
    ["too many entries", Array.from({ length: 21 }, (_, i) => ({ connection: `c${i}`, to: "x", operations: ["send"] }))],
    ["same connection twice without alias", [send("a"), send("a", "#other")]],
    ["duplicate alias", [send("a", "x", { alias: "z" }), send("b", "x", { alias: "z" })]],
  ])("rejects %s", (_name, raw) => {
    expect(parseChannels(raw).ok).toBe(false);
  });

  it("allows one connection twice when each entry has an alias", () => {
    expect(parseChannels([send("a", "#one", { alias: "one" }), send("a", "#two", { alias: "two" })]).ok).toBe(true);
  });

  it("keys entries by alias, falling back to the connection", () => {
    expect(channelKey(send("a", "x", { alias: "z" }))).toBe("z");
    expect(channelKey(send("a"))).toBe("a");
  });
});

describe("mergeChannelDefaults", () => {
  const defaults = [send("ops", "#ops"), send("mail", ["a@x.test"])];

  it("inherits defaults when the stage declares nothing", () => {
    expect(mergeChannelDefaults(defaults, undefined)).toEqual(defaults);
    expect(mergeChannelDefaults(undefined, undefined)).toBeUndefined();
  });

  it("clears inherited entries with an explicit empty list", () => {
    expect(mergeChannelDefaults(defaults, [])).toEqual([]);
  });

  it("merges by key with the stage entry winning and keeps other defaults", () => {
    const merged = mergeChannelDefaults(defaults, [send("ops", "#stage-only"), send("tg", "1234")]);
    expect(merged).toEqual([send("ops", "#stage-only"), send("mail", ["a@x.test"]), send("tg", "1234")]);
  });

  it("returns copies so callers cannot mutate the defaults", () => {
    const merged = mergeChannelDefaults(defaults, undefined)!;
    merged[0]!.to = "changed";
    expect(defaults[0]?.to).toBe("#ops");
  });
});

describe("loading channels", () => {
  const stage = (extra: Record<string, unknown> = {}) => ({
    id: "a", system_prompt: "hi", model: "anthropic/claude-sonnet-4-5", ...IO, ...extra,
  });

  it("loads stage channels from a stage file", async () => {
    const root = await tmp();
    const file = path.join(root, "a.yaml");
    await writeFile(file, [
      "id: a", "system_prompt: hi", "model: anthropic/claude-sonnet-4-5",
      "io: { input: { schema: { type: object } }, output: { schema: { type: object } } }",
      "channels:", "  - connection: ops", "    to: '#general'", "    operations: [send]", "",
    ].join("\n"));
    const outcome = await loadStageOutcome(file);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.channels).toEqual([send("ops")]);
  });

  it("reports invalid stage channels with a named code", async () => {
    const outcome = await loadPipelineFromObjectOutcome({ id: "p", stages: [stage({ channels: [{ connection: "a" }] })] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]).toMatchObject({ code: "stage.invalid_channels", category: "stage", stageId: "a" });
  });

  it("applies pipeline channels to stages and lets a stage override or clear them", async () => {
    const outcome = await loadPipelineFromObjectOutcome({
      id: "p",
      channels: [send("ops", "#ops"), send("mail", ["a@x.test"])],
      stages: [
        { ...stage(), entry: true, route: [{ to: "b" }] },
        { ...stage({ channels: [send("ops", "#b-only")] }), id: "b", route: [{ to: "c" }] },
        { ...stage({ channels: [] }), id: "c" },
      ],
    });
    expect(outcome.ok ? [] : outcome.issues).toEqual([]);
    if (!outcome.ok) return;
    const byId = Object.fromEntries(outcome.value.stages.map(s => [s.id, s.channels]));
    expect(byId.a).toEqual([send("ops", "#ops"), send("mail", ["a@x.test"])]);
    expect(byId.b).toEqual([send("ops", "#b-only"), send("mail", ["a@x.test"])]);
    expect(byId.c).toEqual([]);
    expect(outcome.value.pipeline.channels).toEqual([send("ops", "#ops"), send("mail", ["a@x.test"])]);
  });

  it("leaves stages without channels untouched when the pipeline has none", async () => {
    const outcome = await loadPipelineFromObjectOutcome({ id: "p", stages: [stage()] });
    expect(outcome.ok && outcome.value.stages[0] && "channels" in outcome.value.stages[0]).toBe(false);
  });

  it("rejects invalid pipeline-level channels", async () => {
    const outcome = await loadPipelineFromObjectOutcome({ id: "p", channels: "nope", stages: [stage()] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.code).toBe("pipeline.invalid_channels");
  });

  it("rejects stages that exceed the channel limit after merging defaults", async () => {
    const defaults = Array.from({ length: 15 }, (_, i) => send(`d${i}`));
    const own = Array.from({ length: 6 }, (_, i) => send(`s${i}`));
    const outcome = await loadPipelineFromObjectOutcome({ id: "p", channels: defaults, stages: [stage({ channels: own })] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.code).toBe("stage.invalid_channels");
  });
});

describe("sf validate against connections.yaml", () => {
  const pipelineYaml = (channels: string) => [
    "id: p", "stages:", "  - id: a", "    system_prompt: hi", "    model: anthropic/claude-sonnet-4-5",
    "    io: { input: { schema: { type: object } }, output: { schema: { type: object } } }",
    ...channels.split("\n").map(line => `    ${line}`), "",
  ].join("\n");
  const connections = (extra = "") => `version: 1\nconnections:\n  - id: ops\n    provider: fake\n    config: { inbox: a@b.test }\n    secrets: { token: env:OPS_TOKEN }\n${extra}`;
  const channelBlock = (connection: string, to = "'#general'") => `channels:\n  - connection: ${connection}\n    to: ${to}\n    operations: [send]`;

  async function validate(channels: string, connectionsYaml?: string, providers = [fakeChannelProvider()]) {
    const root = await tmp();
    await writeFile(path.join(root, "p.pipeline.yaml"), pipelineYaml(channels));
    if (connectionsYaml !== undefined) await writeFile(path.join(root, "connections.yaml"), connectionsYaml);
    return validatePipeline(path.join(root, "p.pipeline.yaml"), { cwd: root, projectRoot: root, channelProviders: providers });
  }
  const messages = (result: Awaited<ReturnType<typeof validate>>) => result.findings.filter(f => f.code === "stage.channel_unavailable").map(f => f.message);

  it("passes when the connection and target are valid", async () => {
    const result = await validate(channelBlock("ops"), connections());
    expect(messages(result)).toEqual([]);
  });

  it("ignores connections.yaml entirely when no stage uses channels", async () => {
    const result = await validate("", "version: 1\nconnections: [nonsense");
    expect(messages(result)).toEqual([]);
  });

  it("reports an undefined connection", async () => {
    const result = await validate(channelBlock("ghost"), connections());
    expect(messages(result)).toEqual(['channel "ghost": connection "ghost" is not defined in connections.yaml']);
    expect(result.ok).toBe(false);
  });

  it("reports a disabled connection", async () => {
    const result = await validate(channelBlock("ops"), connections().replace("provider: fake", "provider: fake\n    enabled: false"));
    expect(messages(result)).toEqual(['channel "ops": connection "ops" is disabled']);
  });

  it("reports a target the provider rejects", async () => {
    const result = await validate(channelBlock("ops", "['a', 'b']"), connections());
    expect(messages(result)[0]).toMatch(/channel "ops": invalid target for fake/);
  });

  it("reports a missing connections.yaml as an undefined connection", async () => {
    const result = await validate(channelBlock("ops"));
    expect(messages(result)[0]).toMatch(/not defined in connections.yaml/);
  });

  it("reports an unloadable connections.yaml without leaking file content", async () => {
    const result = await validate(channelBlock("ops"), "version: 1\nconnections:\n  - id: ops\n    provider: fake\n    secrets: { token: literal-secret-value }\n");
    expect(messages(result)).toEqual(["connections.yaml could not be loaded: CHANNEL_INVALID_INPUT"]);
    expect(JSON.stringify(result.findings)).not.toContain("literal-secret-value");
  });

  it("names the connection and field when a provider entry is invalid", async () => {
    const result = await validate(channelBlock("ops"), connections().replace("{ inbox: a@b.test }", "{ nope: 1 }"));
    expect(messages(result)).toEqual(['connections.yaml could not be loaded: CHANNEL_INVALID_INPUT (connection "ops", field "config")']);
  });

  it("rejects every channel when the provider is not registered", async () => {
    const result = await validate(channelBlock("ops"), connections(), []);
    expect(messages(result)[0]).toMatch(/CHANNEL_PROVIDER_UNSUPPORTED/);
  });
});
