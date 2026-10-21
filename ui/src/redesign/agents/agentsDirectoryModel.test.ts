import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../api/agents";
import { directoryFooterText, directoryHint, directoryTotals, filterAgents, filterCounts, searchAgents, toDirectoryRow } from "./agentsDirectoryModel";

const stats = { total: 0, active: 0, last7Days: 0, waiting: 0, lastActivityAt: null, turnsFinished7d: 0, turnsSucceeded7d: 0, cost7d: null, costTotal: null };

function agent(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    name: over.id,
    description: null,
    enabled: true,
    revision: 1,
    issues: [],
    model: { backend: "pi", thinking: "medium" },
    tools: { builtin: ["read"], builtinTools: [], mcpServers: [], skills: [], browser: false },
    askFirst: [],
    channelConnection: null,
    subAgents: [],
    capture: "metadata",
    stats,
    pendingApprovals: 0,
    updatedAt: "2026-10-15T12:00:00Z",
    ...over,
  };
}

const research = agent({
  id: "research",
  name: "Research assistant",
  description: "Finds sources",
  revision: 3,
  model: { backend: "pi", id: "sonnet", thinking: "high" },
  tools: { builtin: ["read", "shell"], builtinTools: [], mcpServers: ["web"], skills: [], browser: false },
  askFirst: ["web.post"],
  stats: { ...stats, last7Days: 4 },
});
const digest = agent({ id: "digest", enabled: false });
const insights = agent({ id: "insights", issues: [{ path: "tools.mcp.dovetail", code: "agent.mcp_missing", message: "dovetail server not connected" }] });
const catalog = [research, digest, insights];

describe("agents directory model", () => {
  it("derives row display from summaries", () => {
    expect(toDirectoryRow(research)).toMatchObject({
      model: "sonnet",
      modelIsDefault: false,
      backend: "v3",
      toolsLine: "read · shell · 1 MCP",
      approvalsLine: "Asks first: web.post",
      statusLabel: "Enabled",
      last7Days: "4 sessions",
    });
    expect(toDirectoryRow(digest)).toMatchObject({ model: "project default", statusLabel: "Disabled", approvalsLine: "No approvals required" });
    expect(toDirectoryRow(insights)).toMatchObject({ needsSetup: true, statusLabel: "Needs setup", approvalsLine: "dovetail server not connected", approvalsTone: "needs" });
  });

  it("filters by chip", () => {
    expect(filterAgents(catalog, "enabled").map((a) => a.id)).toEqual(["research"]);
    expect(filterAgents(catalog, "disabled").map((a) => a.id)).toEqual(["digest"]);
    expect(filterAgents(catalog, "needs_setup").map((a) => a.id)).toEqual(["insights"]);
    expect(filterCounts(catalog)).toEqual({ all: 3, enabled: 1, disabled: 1, needs_setup: 1 });
  });

  it("searches name, model, tools and issues", () => {
    expect(searchAgents(catalog, "sonnet").map((a) => a.id)).toEqual(["research"]);
    expect(searchAgents(catalog, "dovetail").map((a) => a.id)).toEqual(["insights"]);
    expect(searchAgents(catalog, "  ")).toHaveLength(3);
  });

  it("builds footer text", () => {
    expect(directoryFooterText([])).toBe("No agents yet");
    expect(directoryFooterText(catalog)).toBe("3 agents in agents/ · 1 enabled · 1 needs setup");
  });
});

describe("directoryTotals", () => {
  it("sums session counts and known costs, dash when none", () => {
    expect(directoryTotals([agent({ id: "a" })])).toEqual({ sessions: 0, cost: "—" });
    const a = agent({ id: "a", stats: { ...stats, total: 2, costTotal: 0.5 } });
    const b = agent({ id: "b", stats: { ...stats, total: 1, costTotal: 0.25 } });
    expect(directoryTotals([a, b])).toEqual({ sessions: 3, cost: "$0.75" });
  });
  it("labels disabled rows as paused", () => {
    const row = toDirectoryRow(agent({ id: "a", enabled: false }));
    expect([row.statusLabel, row.statusNote]).toEqual(["Disabled", "Paused"]);
  });
});

describe("reach", () => {
  it("shows web chat link, channel provider, schedule, else console only", () => {
    const web = toDirectoryRow(agent({ id: "w", webChatUrl: "/chat/abc" }));
    expect(web.reach).toMatchObject([{ kind: "web", label: "Web chat", href: "/chat/abc" }]);
    const ch = toDirectoryRow(agent({ id: "c", channelConnection: "im_1", scheduleCron: "0 9 * * *" }), 0, (id) => (id === "im_1" ? "iMessage" : undefined));
    expect(ch.reach.map((r) => [r.kind, r.label, r.detail])).toEqual([["channel", "iMessage", "im_1"], ["schedule", "Schedule", "0 9 * * *"]]);
    expect(toDirectoryRow(agent({ id: "n" })).reach).toMatchObject([{ kind: "console" }]);
  });
  it("search finds by provider", () => {
    const a = agent({ id: "c", channelConnection: "im_1" });
    expect(searchAgents([a], "imessage", () => "iMessage")).toHaveLength(1);
  });
});

describe("directoryHint", () => {
  it("is null when every agent is enabled and valid", () => {
    expect(directoryHint([research])).toBeNull();
    expect(directoryHint([])).toBeNull();
  });
  it("explains the first issue of each broken agent and what disabled means", () => {
    expect(directoryHint([research, digest])).toBe("Disabled agents keep their history but can't start sessions.");
    expect(directoryHint([insights])).toBe("insights can't be enabled until dovetail server not connected.");
    expect(directoryHint(catalog)).toBe(
      "insights can't be enabled until dovetail server not connected. Disabled agents keep their history but can't start sessions.",
    );
  });
});
