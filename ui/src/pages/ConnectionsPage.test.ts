import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConnections } from "../api";
import { defaultRailItems } from "../components/AppRail";
import { NAV_GROUPS } from "../redesign/shell/navConfig";
import { parseHash } from "../routes";

afterEach(() => vi.unstubAllGlobals());

describe("Connections", () => {
  it("is reachable from the sidebar and direct URL", () => {
    expect(defaultRailItems.find((item) => item.id === "connections")?.label).toBe("Connections");
    const item = NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === "connections");
    expect(item).toMatchObject({ label: "Connections", href: "#/connections" });
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
    expect(JSON.stringify(connections)).not.toContain("private-");
  });

  it("reports load failures instead of claiming there are no accounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "Unavailable" }) }));
    await expect(fetchConnections()).rejects.toThrow("Unavailable");
  });
});
