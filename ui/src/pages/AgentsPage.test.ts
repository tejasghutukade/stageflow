import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiError, agentsApi } from "../api/agents";
import { defaultRailItems } from "../components/AppRail";
import { NAV_GROUPS } from "../redesign/shell/navConfig";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("Agents console", () => {
  it("is reachable from the sidebar", () => {
    expect(defaultRailItems.find((item) => item.id === "agents")?.label).toBe("Agents");
    const item = NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === "agents");
    expect(item).toMatchObject({ label: "Agents", href: "#/agents" });
    expect(item?.soon).toBeUndefined();
  });

  it("enables, disables and saves through the typed API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { agent: { id: "research" } }));
    vi.stubGlobal("fetch", fetchMock);
    await agentsApi.setEnabled("research", true);
    await agentsApi.setEnabled("research", false);
    await agentsApi.save("research", { baseRevision: 2, definition: { id: "research" } });
    expect(fetchMock.mock.calls.map((call) => [call[1].method, call[0]])).toEqual([
      ["POST", "/api/agents/research/enable"],
      ["POST", "/api/agents/research/disable"],
      ["POST", "/api/agents/research/save"],
    ]);
  });

  it("surfaces a stale save as agent.conflict", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, { code: "agent.conflict", message: "stale" })));
    const attempt = agentsApi.save("research", { baseRevision: 1, definition: {} });
    await expect(attempt).rejects.toMatchObject({ code: "agent.conflict" });
    await expect(attempt).rejects.toBeInstanceOf(AgentApiError);
  });
});
