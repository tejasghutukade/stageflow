import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChannelConnection, fetchChannelConnections } from "../api";
import { ageLabel, channelStatus } from "./channelStatus";
import {
  PROVIDERS, availableProviders, channelRows, connectionTotals, footerText, toolCards,
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
    expect(result).toEqual({ connections: [{ ...base, health: { state: "failed", checkedAt: "2026-10-14T10:00:00Z", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } } }] });
    expect(JSON.stringify(result)).not.toContain("SECRET_NAME");
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("passes a load error code through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED" }) }));
    expect(await fetchChannelConnections()).toEqual({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED" });
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

  it("separates setup problems from transient failures", () => {
    expect(channelStatus(failed("CHANNEL_AUTH_FAILED"))).toEqual({ label: "Needs setup", tone: "needs", detail: "Credentials were rejected" });
    expect(channelStatus(failed("CHANNEL_SECRET_UNAVAILABLE")).label).toBe("Needs setup");
    expect(channelStatus(failed("CHANNEL_CONNECTION_FAILED"))).toMatchObject({ label: "Check failed", tone: "needs" });
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
    const rows = channelRows([{ ...base, health: { state: "ok", checkedAt: "x" } }, failed("CHANNEL_AUTH_FAILED"), { ...base, id: "n" }], []);
    const tools = toolCards([{ name: "github", transport: "http" }]);
    expect(tools).toEqual([{ name: "github", detail: "http server · .mcp.json" }]);
    const totals = connectionTotals(rows, tools);
    expect(totals).toEqual({ connections: 4, channels: 3, tools: 1, needsAttention: 1, connectedChannels: 1 });
    expect(footerText(totals)).toBe("4 connections · 3 channels · 1 tool · 1 needs attention");
    expect(footerText({ connections: 1, channels: 1, tools: 0, needsAttention: 0, connectedChannels: 0 })).toBe("1 connection · 1 channel · 0 tools");
  });
});
