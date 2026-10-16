import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../api/agents";
import { directoryFooterText, filterAgents, filterCounts, searchAgents, toDirectoryRow } from "./agentsDirectoryModel";

const stats = { total: 0, active: 0, last7Days: 0, waiting: 0, lastActivityAt: null, turnsFinished7d: 0, turnsSucceeded7d: 0, cost7d: null };

function agent(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    name: over.id,
    description: null,
    enabled: true,
    revision: 1,
    issues: [],
    model: { backend: "pi", thinking: "medium" },
    tools: { builtin: ["read"], mcpServers: [], skills: [], browser: false },
    askFirst: [],
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
  tools: { builtin: ["read", "shell"], mcpServers: ["web"], skills: [], browser: false },
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
