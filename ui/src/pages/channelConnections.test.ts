import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChannelConnection, fetchChannelConnections } from "../api";
import { ChannelTable, ToolTable } from "./ConnectionsPage";
import { ageLabel, channelStatus } from "./channelStatus";

afterEach(() => vi.unstubAllGlobals());

const base = { id: "ops", provider: "slack", displayName: "Ops Slack", enabled: true, identity: "T0123ABCD" };

describe("channel connections", () => {
  it("projects the listing without carrying unknown fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      connections: [{ ...base, scope: "/private/path", secrets: { botToken: "env:SECRET_NAME" }, health: { state: "failed", checkedAt: "2026-10-14T10:00:00Z", error: { code: "CHANNEL_AUTH_FAILED", retryable: false }, extra: 1 } }],
      error: undefined,
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

  it("never says Connected before a check has run", () => {
    expect(channelStatus(base)).toEqual({ label: "Not checked yet", tone: "muted" });
    expect(channelStatus({ ...base, enabled: false })).toEqual({ label: "Disabled", tone: "muted" });
    expect(channelStatus({ ...base, health: { state: "ok", checkedAt: "x" } }).label).toBe("Connected");
    expect(channelStatus({ ...base, health: { state: "failed", checkedAt: "x", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } } }))
      .toEqual({ label: "Check failed", tone: "fail", detail: "Credentials were rejected" });
  });

  it("formats check age", () => {
    const now = Date.parse("2026-10-14T10:10:00Z");
    expect(ageLabel("2026-10-14T10:09:40Z", now)).toBe("just now");
    expect(ageLabel("2026-10-14T10:05:00Z", now)).toBe("5 min ago");
    expect(ageLabel("2026-10-14T07:10:00Z", now)).toBe("3 h ago");
    expect(ageLabel("garbage", now)).toBe("");
  });

  it("renders rows with provider label, identity and a check button only when enabled", () => {
    const html = renderToStaticMarkup(createElement(ChannelTable, {
      connections: [base, { ...base, id: "off", displayName: "Off", enabled: false }],
      onCheck: () => {}, now: Date.parse("2026-10-14T10:10:00Z"),
    }));
    expect(html).toContain("Slack");
    expect(html).toContain("T0123ABCD");
    expect(html).toContain("Not checked yet");
    expect(html).toContain("Disabled");
    expect(html.match(/Check now/g)).toHaveLength(1);
    expect(html).not.toContain("Connected");
  });

  it("lists tool servers read-only", () => {
    const html = renderToStaticMarkup(createElement(ToolTable, { servers: [{ name: "github", transport: "http" }] }));
    expect(html).toContain("github");
    expect(html).toContain("http");
    expect(html).not.toContain("<button");
  });
});
