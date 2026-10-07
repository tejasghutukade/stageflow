import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConnections } from "../api";
import { defaultRailItems } from "../components/AppRail";
import { parseHash } from "../routes";
import { ConnectionTable } from "./ConnectionsPage";

afterEach(() => vi.unstubAllGlobals());

describe("Connections", () => {
  it("is reachable from the sidebar and direct URL", () => {
    expect(defaultRailItems.find((item) => item.id === "connections")?.label).toBe("Connections");
    expect(parseHash("#/connections")).toEqual({ name: "connections" });
  });

  it("projects email accounts without carrying credential or server fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accounts: [{
      accountId: "test-inbox", displayName: "Test email", address: "test@example.com",
      enabled: true, folders: ["INBOX"],
      imap: { host: "private-server", auth: { secretRef: "local:private-reference", password: "private-password" } },
      smtp: { username: "private-user" }, scope: "private-scope",
    }] }) }));
    const connections = await fetchConnections();
    expect(connections).toEqual([{
      id: "test-inbox", channel: "Email", displayName: "Test email", address: "test@example.com",
      enabled: true, folders: ["INBOX"],
    }]);
    const html = renderToStaticMarkup(createElement(ConnectionTable, { connections }));
    expect(html).toContain("Test email");
    expect(html).toContain("test@example.com");
    expect(html).toContain("Enabled");
    expect(html).not.toContain("private-");
    expect(html).not.toContain("Connected");
  });

  it("keeps disabled accounts visible", () => {
    const html = renderToStaticMarkup(createElement(ConnectionTable, { connections: [{
      id: "disabled", channel: "Email", displayName: "Disabled email", address: "test@example.com",
      enabled: false, folders: ["INBOX", "Updates"],
    }] }));
    expect(html).toContain("Disabled");
    expect(html).toContain("INBOX, Updates");
  });

  it("reports load failures instead of claiming there are no accounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Unavailable" }) }));
    await expect(fetchConnections()).rejects.toThrow("Unavailable");
  });
});
