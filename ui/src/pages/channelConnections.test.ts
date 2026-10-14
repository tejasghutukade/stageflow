import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelApiError, checkChannelConnection, createChannelConnection, deleteChannelConnection, fetchChannelConnections,
  testChannelConnection, updateChannelConnection,
} from "../api";
import { parseHash, connectionPath } from "../routes";
import { parse as parseYaml } from "yaml";
import { ageLabel, channelStatus } from "./channelStatus";
import {
  PROVIDERS, PROVIDER_FORMS, apiErrorMessage, availableProviders, buildNewConnection, missingFields, channelRows, connectionTotals, detailFacts, fixHint, footerText, toolCards, usageSnippet,
} from "../redesign/connections/connectionsModel";

afterEach(() => vi.unstubAllGlobals());

const base = { id: "ops", provider: "slack", displayName: "Ops Slack", enabled: true, identity: "T0123ABCD" };
const failed = (code: string) => ({ ...base, health: { state: "failed" as const, checkedAt: "x", error: { code, retryable: false } } });

describe("channel connections api", () => {
  it("projects the listing without carrying unknown fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      connections: [{ ...base, scope: "/private/path", secrets: { botToken: "env:SECRET_NAME" }, health: { state: "failed", checkedAt: "2026-10-14T10:00:00Z", error: { code: "CHANNEL_AUTH_FAILED", retryable: false }, extra: 1 } }],
    }) }));
    const result = await fetchChannelConnections();
    expect(result).toEqual({ connections: [{ ...base, secrets: { botToken: "env" }, health: { state: "failed", checkedAt: "2026-10-14T10:00:00Z", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } } }], limits: { channelsPerStage: 1 } });
    expect(JSON.stringify(result)).not.toContain("SECRET_NAME");
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("passes a load error code through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED" }) }));
    expect(await fetchChannelConnections()).toEqual({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED", limits: { channelsPerStage: 1 } });
  });

  it("follows the host's per-stage channel limit and falls back to one for anything odd", async () => {
    for (const [limits, expected] of [[{ channelsPerStage: 3 }, 3], [undefined, 1], [{ channelsPerStage: 0 }, 1], [{ channelsPerStage: "many" }, 1], [{ channelsPerStage: 1.5 }, 1]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connections: [], ...(limits ? { limits } : {}) }) }));
      expect((await fetchChannelConnections()).limits.channelsPerStage).toBe(expected);
    }
  });

  it("posts a check to the connection's own path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: "ok", checkedAt: "2026-10-14T10:00:00Z" }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkChannelConnection("a/b")).toMatchObject({ state: "ok" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/connections/a%2Fb/check");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
  });
});

describe("status vocabulary", () => {
  it("never says Connected before a check has run", () => {
    expect(channelStatus(base)).toEqual({ label: "Not checked yet", tone: "muted" });
    expect(channelStatus({ ...base, enabled: false })).toEqual({ label: "Disabled", tone: "muted" });
    expect(channelStatus({ ...base, health: { state: "ok", checkedAt: "x" } })).toEqual({ label: "Connected", tone: "ok" });
  });

  it("tells a missing secret (not connected yet) apart from a broken connection", () => {
    expect(channelStatus(failed("CHANNEL_SECRET_UNAVAILABLE"))).toMatchObject({ label: "Not connected", tone: "muted" });
    expect(channelStatus(failed("CHANNEL_AUTH_FAILED"))).toEqual({ label: "Connection broken", tone: "needs", detail: "Credentials were rejected" });
    expect(channelStatus(failed("CHANNEL_CONNECTION_FAILED"))).toMatchObject({ label: "Connection broken", tone: "needs" });
  });

  it("formats check age", () => {
    const now = Date.parse("2026-10-14T10:10:00Z");
    expect(ageLabel("2026-10-14T10:09:40Z", now)).toBe("just now");
    expect(ageLabel("2026-10-14T10:05:00Z", now)).toBe("5 min ago");
    expect(ageLabel("2026-10-14T07:10:00Z", now)).toBe("3 h ago");
    expect(ageLabel("garbage", now)).toBe("");
  });
});

describe("connections view model", () => {
  const email = [{ id: "mail", channel: "Email" as const, displayName: "Support mail", address: "s@x.test", enabled: true, folders: ["INBOX"] }];

  it("builds rows for channels and email accounts", () => {
    const rows = channelRows([base, { ...base, id: "wa", provider: "whatsapp", displayName: "WA" }], email);
    expect(rows.map((row) => [row.name, row.kind, row.viaPhoton])).toEqual([["Slack", "channel", false], ["WhatsApp Business", "channel", true], ["Support mail", "email", false]]);
    expect(rows[0]!.secondary).toBe("T0123ABCD · ops");
    expect(rows[2]!.secondary).toBe("s@x.test · IMAP/SMTP");
    expect(rows[2]).toMatchObject({ checkable: false, status: { label: "Enabled", tone: "muted" } });
  });

  it("only lets enabled channels be checked", () => {
    const rows = channelRows([base, { ...base, id: "off", enabled: false }], []);
    expect(rows.map((row) => row.checkable)).toEqual([true, false]);
  });

  it("offers only providers that have no connection yet", () => {
    expect(availableProviders([]).map((provider) => provider.id)).toEqual(PROVIDERS.map((provider) => provider.id));
    const rows = channelRows([base, { ...base, id: "t", provider: "telegram" }], []);
    expect(availableProviders(rows).map((provider) => provider.id)).toEqual(["agentmail", "imessage", "whatsapp"]);
  });

  it("every provider snippet names its provider and only env references", () => {
    for (const provider of PROVIDERS) {
      expect(provider.yaml).toContain(`provider: ${provider.id}`);
      expect(provider.yaml).toMatch(/env:[A-Z_]+/);
      expect(provider.yaml).not.toMatch(/xox[bp]-|\d{6,}:[A-Za-z]/);
      for (const name of provider.env) expect(provider.yaml).toContain(`env:${name}`);
    }
  });

  it("counts totals for the footer", () => {
    const rows = channelRows([{ ...base, health: { state: "ok", checkedAt: "x" } }, failed("CHANNEL_AUTH_FAILED"), failed("CHANNEL_SECRET_UNAVAILABLE")], []);
    const tools = toolCards([{ name: "github", transport: "http" }]);
    expect(tools).toEqual([{ name: "github", detail: "http server · .mcp.json" }]);
    const totals = connectionTotals(rows, tools);
    expect(totals).toEqual({ connections: 4, channels: 3, tools: 1, needsAttention: 1, connectedChannels: 1 });
    expect(footerText(totals)).toBe("4 connections · 3 channels · 1 tool · 1 needs attention");
    expect(footerText({ connections: 0, channels: 0, tools: 0, needsAttention: 0, connectedChannels: 0 })).toBe("No connections yet");
    expect(footerText({ connections: 1, channels: 1, tools: 0, needsAttention: 0, connectedChannels: 0 })).toBe("1 connection · 1 channel · 0 tools");
  });
});

describe("connection detail", () => {
  it("routes /connections/<id> and round-trips odd ids", () => {
    expect(parseHash("#/connections/ops-slack")).toEqual({ name: "connection", connectionId: "ops-slack" });
    expect(parseHash(`#${connectionPath("a b/c")}`)).toEqual({ name: "connection", connectionId: "a b/c" });
    expect(parseHash("#/connections")).toEqual({ name: "connections" });
  });

  it("generates a valid stage channels snippet for every provider", () => {
    for (const provider of PROVIDERS) {
      const parsed = parseYaml(usageSnippet(provider.id, "my-conn")) as { channels: Array<{ connection: string; to: unknown; operations: string[] }> };
      expect(parsed.channels[0]).toMatchObject({ connection: "my-conn", operations: ["send"] });
      expect(parsed.channels[0]!.to).toBeTruthy();
    }
    expect(usageSnippet("whatsapp", "w")).toContain("template:");
    expect(usageSnippet("nope", "x")).toContain("<target>");
  });

  it("explains failures and lists connection facts without secrets", () => {
    expect(fixHint("CHANNEL_AUTH_FAILED")).toMatch(/rejected/);
    expect(fixHint("CHANNEL_SECRET_UNAVAILABLE")).toMatch(/environment variable/);
    expect(fixHint("CHANNEL_SEND_OUTCOME_UNKNOWN")).toBeUndefined();
    expect(fixHint(undefined)).toBeUndefined();
    const facts = detailFacts({ ...base, credential: "photon-main" });
    expect(facts.map((fact) => fact.label)).toEqual(["Provider", "Connection id", "Identity", "Shared credential", "Enabled"]);
    expect(detailFacts({ ...base, identity: undefined }).map((fact) => fact.label)).not.toContain("Identity");
  });

  it("keeps the shared credential id in the projection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connections: [{ ...base, credential: "photon-main", secrets: { x: "y" } }] }) }));
    const result = await fetchChannelConnections();
    expect(result.connections[0]).toMatchObject({ credential: "photon-main" });
    expect(JSON.stringify(result)).not.toContain('"y"');
    expect(result.connections[0]!.secrets).toEqual({ x: "env" });
  });
});

describe("connect forms", () => {
  it("builds an AgentMail payload with config and secret separated and the default region", () => {
    const body = buildNewConnection("agentmail", { inbox: " a@agentmail.to ", apiKey: "am_key" });
    expect(body).toEqual({ provider: "agentmail", config: { inbox: "a@agentmail.to", region: "us" }, secrets: { apiKey: "am_key" } });
  });

  it("omits blank optional fields", () => {
    expect(buildNewConnection("slack", { botToken: "xoxb-1", teamId: "  " })).toEqual({ provider: "slack", config: {}, secrets: { botToken: "xoxb-1" } });
    expect(buildNewConnection("telegram", { botToken: "1:a", botUsername: "acme_bot" }).config).toEqual({ botUsername: "acme_bot" });
  });

  it("sends Photon values as a new credential, or references the saved one", () => {
    const fresh = buildNewConnection("imessage", { projectId: "p", projectSecret: "s" });
    expect(fresh).toEqual({ provider: "imessage", config: {}, secrets: {}, credential: { secrets: { projectId: "p", projectSecret: "s" } } });
    const saved = buildNewConnection("whatsapp", { projectId: "ignored", projectSecret: "ignored" }, { savedCredential: "photon-main" });
    expect(saved).toEqual({ provider: "whatsapp", config: {}, secrets: {}, credential: "photon-main" });
    expect(JSON.stringify(saved)).not.toContain("ignored");
  });

  it("reports missing required fields and lets a saved credential satisfy Photon ones", () => {
    expect(missingFields("agentmail", { inbox: "x" }, false)).toEqual(["apiKey"]);
    expect(missingFields("agentmail", { inbox: "x", apiKey: "k" }, false)).toEqual([]);
    expect(missingFields("imessage", {}, false)).toEqual(["projectId", "projectSecret"]);
    expect(missingFields("imessage", {}, true)).toEqual([]);
  });

  it("every provider form marks secrets as password inputs", () => {
    for (const form of Object.values(PROVIDER_FORMS)) {
      for (const field of form.fields.filter((entry) => entry.target !== "config")) expect(field.input).toBe("password");
    }
    expect(apiErrorMessage("CHANNEL_OPERATION_CONFLICT")).toMatch(/already exists/);
    expect(apiErrorMessage("HTTP_500")).toBe("Request failed (HTTP_500)");
  });
});

describe("connection mutations", () => {
  const ok = (body: unknown, status = 200) => vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

  it("posts create and test bodies as given and returns the health", async () => {
    const fetchMock = ok({ id: "inbox", health: { state: "ok", checkedAt: "x" } }, 201);
    vi.stubGlobal("fetch", fetchMock);
    const input = { provider: "agentmail", config: { inbox: "a@b.test" }, secrets: { apiKey: "k" } };
    expect(await createChannelConnection(input)).toMatchObject({ id: "inbox" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/connections");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(input);
    vi.stubGlobal("fetch", ok({ state: "ok", checkedAt: "x" }));
    await testChannelConnection(input);
  });

  it("patches and deletes on the connection's own path", async () => {
    const fetchMock = ok({});
    vi.stubGlobal("fetch", fetchMock);
    await updateChannelConnection("a/b", { enabled: false });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/connections/a%2Fb");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "PATCH" });
    await deleteChannelConnection("a/b");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });

  it("surfaces the error code and never the request body", async () => {
    vi.stubGlobal("fetch", ok({ code: "CHANNEL_INVALID_INPUT" }, 400));
    const error = await createChannelConnection({ provider: "slack", config: {}, secrets: { botToken: "super-secret" } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelApiError);
    expect((error as ChannelApiError).code).toBe("CHANNEL_INVALID_INPUT");
    expect(String(error) + JSON.stringify(error)).not.toContain("super-secret");
  });
});
