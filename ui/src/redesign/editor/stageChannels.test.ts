import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChannelConnectionListing, DraftPackagePayload } from "../../api";
import type { ChannelMeta } from "../../api";
import metaFixture from "../connections/metaFixture.json";
import { readStageChannels, writeStageChannels, type StageChannelEntry } from "../workshop/inspector/stageFields";
import { StageChannelsSection } from "./StageChannelsSection";
import {
  connectionNote, draftToTemplate, duplicateKeys, emptyChannelEntry, isFilled, parseTo, recipientsText, splitList,
  targetBody, targetSpec, templateToDraft,
} from "./stageChannelsModel";

const meta = metaFixture as ChannelMeta;
const conn = (extra: Partial<ChannelConnectionListing> = {}): ChannelConnectionListing =>
  ({ id: "ops", provider: "slack", displayName: "Ops", enabled: true, ...extra });

const inlineDraft = (): DraftPackagePayload => ({
  pipeline: { id: "p", stages: [{ id: "a", system_prompt: "x", model: "m" }] },
});

const filePackage = (): DraftPackagePayload => ({
  pipeline: { id: "p", stages: [{ id: "a", uses: "./a.yaml" }] },
  stages: [{ path: "./a.yaml", body: { id: "a", system_prompt: "x" } }],
});

describe("stage channel drafts", () => {
  const entry: StageChannelEntry = { connection: "ops", to: "C0123ABCD", operations: ["send"] };

  it("writes channels onto an inline stage and reads them back", () => {
    const next = writeStageChannels(inlineDraft(), "a", [entry, { ...entry, alias: "second", to: ["a@b.test"], cc: ["c@b.test"] }]);
    expect(next.pipeline.stages[0]!.channels).toHaveLength(2);
    expect(readStageChannels(next, "a")).toEqual([entry, { ...entry, alias: "second", to: ["a@b.test"], cc: ["c@b.test"] }]);
  });

  it("writes onto the stage file body, never the uses wrapper", () => {
    const next = writeStageChannels(filePackage(), "a", [entry]);
    expect(next.stages![0]!.body.channels).toEqual([entry]);
    expect(next.pipeline.stages[0]!.channels).toBeUndefined();
    expect(readStageChannels(next, "a")).toEqual([entry]);
  });

  it("removing the last channel drops the key so the stage inherits defaults", () => {
    const withOne = writeStageChannels(inlineDraft(), "a", [entry]);
    const cleared = writeStageChannels(withOne, "a", []);
    expect("channels" in cleared.pipeline.stages[0]!).toBe(false);
    expect(readStageChannels(cleared, "a")).toEqual([]);
  });

  it("does not mutate the draft it was given and ignores an unknown stage", () => {
    const draft = inlineDraft();
    writeStageChannels(draft, "a", [entry]);
    expect(draft.pipeline.stages[0]!.channels).toBeUndefined();
    expect(writeStageChannels(draft, "nope", [entry])).toBe(draft);
    expect(readStageChannels(draft, "nope")).toEqual([]);
  });

  it("reads numeric recipients and tolerates malformed entries", () => {
    const draft = inlineDraft();
    draft.pipeline.stages[0]!.channels = [{ connection: "t", to: 42, operations: ["send"] }, "junk", { to: ["x"] }];
    expect(readStageChannels(draft, "a")).toEqual([
      { connection: "t", to: "42", operations: ["send"] },
      { connection: "", to: ["x"], operations: ["send"] },
    ]);
  });
});

describe("stage channel form model", () => {
  it("describes the recipient field per provider", () => {
    expect(targetSpec("agentmail", meta)).toMatchObject({ multiple: true, cc: true, template: false });
    expect(targetSpec("whatsapp", meta)).toMatchObject({ template: true, multiple: false });
    expect(targetSpec("slack", meta).toLabel).toBe("Channel id");
    expect(targetSpec("nope", meta)).toMatchObject({ toLabel: "To", multiple: false });
    expect(targetSpec(undefined, meta).cc).toBe(false);
    expect(targetSpec("slack")).toMatchObject({ toLabel: "To" });
  });

  it("parses recipient text", () => {
    expect(splitList(" a@b.test,\n c@b.test ,, ")).toEqual(["a@b.test", "c@b.test"]);
    expect(parseTo("a@b.test", true)).toBe("a@b.test");
    expect(parseTo("a@b.test, c@b.test", true)).toEqual(["a@b.test", "c@b.test"]);
    expect(parseTo(" C123 ", false)).toBe("C123");
    expect(recipientsText(["a", "b"])).toBe("a, b");
    expect(recipientsText(undefined)).toBe("");
  });

  it("starts a new entry on the first enabled connection and detects duplicates and empties", () => {
    expect(emptyChannelEntry([conn({ id: "off", enabled: false }), conn({ id: "on" })])).toEqual({ connection: "on", to: "", operations: ["send"] });
    expect(emptyChannelEntry([])).toEqual({ connection: "", to: "", operations: ["send"] });
    expect(duplicateKeys([{ connection: "a", to: "x", operations: [] }, { connection: "a", to: "y", operations: [] }, { connection: "a", alias: "b", to: "z", operations: [] }])).toEqual(["a"]);
    expect(isFilled({ connection: "a", to: "  ", operations: [] })).toBe(false);
    expect(isFilled({ connection: "a", to: ["x"], operations: [] })).toBe(true);
    expect(isFilled({ connection: "", to: "x", operations: [] })).toBe(false);
  });

  it("builds the validate body and WhatsApp template round trip", () => {
    expect(targetBody({ connection: "a", to: "x", operations: [] })).toEqual({ to: "x" });
    expect(targetBody({ connection: "a", to: ["x"], cc: ["y"], template: { name: "n" }, operations: [] })).toEqual({ to: ["x"], cc: ["y"], template: { name: "n" } });
    expect(draftToTemplate({ name: "", languageCode: "", bodyParams: "" })).toBeUndefined();
    expect(draftToTemplate({ name: " order ", languageCode: "en_US", bodyParams: "Hi, {{message}}" })).toEqual({ name: "order", languageCode: "en_US", bodyParams: ["Hi", "{{message}}"] });
    expect(templateToDraft({ name: "n", languageCode: "en", bodyParams: ["a", "b"] })).toEqual({ name: "n", languageCode: "en", bodyParams: "a, b" });
    expect(templateToDraft(undefined)).toEqual({ name: "", languageCode: "", bodyParams: "" });
  });

  it("notes what the editor knows about the selected connection", () => {
    expect(connectionNote(undefined, "").text).toBe("Choose a connection");
    expect(connectionNote(undefined, "gone").text).toMatch(/not defined/);
    expect(connectionNote(conn({ enabled: false }), "ops").text).toMatch(/Disabled/);
    expect(connectionNote(conn(), "ops")).toEqual({ tone: "muted", text: "Not checked yet" });
    expect(connectionNote(conn({ health: { state: "ok", checkedAt: "x" } }), "ops")).toEqual({ tone: "ok", text: "Connected" });
    expect(connectionNote(conn({ health: { state: "failed", checkedAt: "x", error: { code: "CHANNEL_SECRET_UNAVAILABLE", retryable: false } } }), "ops").text).toBe("Not connected");
    expect(connectionNote(conn({ health: { state: "failed", checkedAt: "x", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } } }), "ops").text).toBe("Connection broken");
  });
});

describe("StageChannelsSection with the one-channel policy", () => {
  const render = (entries: StageChannelEntry[], limit?: number, connections = [conn()]) =>
    renderToStaticMarkup(createElement(StageChannelsSection, { entries, connections, meta, loadFailed: false, ...(limit !== undefined ? { limit } : {}), onChange: () => {} }));
  const one: StageChannelEntry = { connection: "ops", to: "C0123ABCD", operations: ["send"] };

  it("defaults to one: an empty stage can add, a stage with one cannot", () => {
    expect(render([])).toContain("Add channel");
    const full = render([one]);
    expect(full).not.toContain("Add channel");
    expect(full).toContain("A stage can use one channel for now.");
    expect(full).toContain("split the work into a separate stage");
  });

  it("hides the channel name field while only one is allowed", () => {
    const html = render([one]);
    expect(html).not.toContain("Channel name");
    expect(html).not.toContain("send_message with this name");
    expect(render([one], 3)).toContain("Channel name");
  });

  it("warns, and offers removal, when a file already lists more than the limit", () => {
    const html = render([one, { ...one, connection: "ops", alias: "b" }]);
    expect(html).toContain("lists 2 channels but can use 1");
    expect(html).toContain("Remove channel");
    expect(html).not.toContain("Add channel");
  });

  it("offers Add again when the host raises the limit", () => {
    expect(render([one], 2)).toContain("Add channel");
    expect(render([one, one], 2)).not.toContain("Add channel");
    expect(render([one, one], 2)).toContain("A stage can use up to 2 channels.");
  });
});

describe("StageChannelsSection", () => {
  const render = (entries: StageChannelEntry[], connections: ChannelConnectionListing[] = [conn()], loadFailed = false, limit = 5) =>
    renderToStaticMarkup(createElement(StageChannelsSection, { entries, connections, meta, loadFailed, limit, onChange: () => {} }));

  it("explains the empty state and disables Add when there are no connections", () => {
    const empty = render([], []);
    expect(empty).toContain("No channels");
    expect(empty).toContain("no connections exist yet");
    expect(empty).toContain("disabled");
    expect(render([], [conn()])).not.toContain("no connections exist yet");
  });

  it("renders a card with provider fields, status note and the send_message name", () => {
    const html = render([{ connection: "ops", alias: "alerts", to: "C0123ABCD", operations: ["send"] }]);
    expect(html).toContain("Channel id");
    expect(html).toContain("C0123ABCD");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("send_message with this name: alerts");
    expect(html).not.toContain("Cc");
  });

  it("shows Cc for AgentMail and template fields for WhatsApp", () => {
    const mail = render([{ connection: "m", to: ["a@b.test"], operations: ["send"] }], [conn({ id: "m", provider: "agentmail" })]);
    expect(mail).toContain("Cc");
    const wa = render([{ connection: "w", to: "+14155550123", operations: ["send"] }], [conn({ id: "w", provider: "whatsapp" })]);
    expect(wa).toContain("Template name");
    expect(wa).toContain("24-hour");
  });

  it("flags a missing connection and a duplicate name, and a failed load", () => {
    const html = render([{ connection: "gone", to: "x", operations: ["send"] }, { connection: "gone", to: "y", operations: ["send"] }], [conn()], true);
    expect(html).toContain("not defined in connections");
    expect(html).toContain("must be unique");
    expect(html).toContain("Could not load connections");
  });
});
