import { describe, expect, it } from "vitest";
import type { EvalAgentTarget } from "../../../api/evalTypes";
import { agentRowView, askFirstLine, filterAgents, findAgent, pickerNotice, riskBadges, toolSummary } from "./agentPickerModel";

function agent(overrides: Partial<EvalAgentTarget> = {}): EvalAgentTarget {
  return {
    id: "support",
    name: "Support",
    model: "anthropic/claude-sonnet-4-5",
    revision: 4,
    enabled: true,
    tools: [
      { id: "read", risk: "read", class: "read" },
      { id: "grep", risk: "read", class: "read" },
      { id: "bash", risk: "write", class: "shell" },
      { id: "billing.refund", risk: "unknown", class: "mcp_unknown" },
      { id: "agent:helper", risk: "read", class: "sub_agent" },
      { id: "edit", risk: "write", class: "write" },
      { id: "stageflow.rm", risk: "destructive", class: "destructive" },
    ],
    ask_first: ["billing.refund", "bash"],
    evals_count: 2,
    issues: [],
    unavailable_reason: null,
    ...overrides,
  };
}

describe("risk badges", () => {
  it("counts tools per class in the fixed order and folds destructive into write", () => {
    expect(riskBadges(agent().tools).map((b) => `${b.label} ${b.count}`)).toEqual(["Read 2", "Write 2", "Shell 1", "Unknown MCP 1", "Sub-agent 1"]);
    expect(riskBadges([])).toEqual([]);
  });

  it("gives each class its tone", () => {
    const tones = Object.fromEntries(riskBadges(agent().tools).map((b) => [b.label, b.tone]));
    expect(tones).toMatchObject({ Read: "ok", Write: "needs", Shell: "fail", "Unknown MCP": "unknown", "Sub-agent": "neutral" });
  });

  it("summarises the tools in one line", () => {
    expect(toolSummary(agent().tools)).toBe("7 tools: 2 read, 2 write, 1 shell, 1 unknown mcp, 1 sub-agent");
    expect(toolSummary([])).toBe("No tools");
  });

  it("lists what asks first", () => {
    expect(askFirstLine(["billing.refund", "bash"])).toBe("asks first: billing.refund, bash");
    expect(askFirstLine([])).toBeNull();
  });
});

describe("agent rows", () => {
  it("shows name, model, revision, evals count", () => {
    expect(agentRowView(agent())).toMatchObject({ id: "support", name: "Support", model: "anthropic/claude-sonnet-4-5", revision: "r4", evalsText: "2 evals", state: "ok", selectable: true, chip: null });
    expect(agentRowView(agent({ evals_count: 1 })).evalsText).toBe("1 eval");
  });

  it("keeps disabled agents selectable with an amber chip", () => {
    const row = agentRowView(agent({ enabled: false }));
    expect(row).toMatchObject({ state: "disabled", selectable: true, chip: "Disabled: evals bypass this" });
  });

  it("disables archived and invalid agents", () => {
    expect(agentRowView(agent({ unavailable_reason: "archived" }))).toMatchObject({ state: "archived", selectable: false, chip: "Archived" });
    const invalid = agentRowView(agent({ unavailable_reason: "invalid", issues: ["model is missing"] }));
    expect(invalid).toMatchObject({ state: "invalid", selectable: false, title: "model is missing" });
  });
});

describe("search and notices", () => {
  const items = [agent(), agent({ id: "triage", name: "Triage", model: "openai/gpt-5" })];

  it("filters by id, name or model", () => {
    expect(filterAgents(items, "tri").map((a) => a.id)).toEqual(["triage"]);
    expect(filterAgents(items, "GPT").map((a) => a.id)).toEqual(["triage"]);
    expect(filterAgents(items, "  ")).toHaveLength(2);
  });

  it("explains loading, errors, empty lists and no matches", () => {
    expect(pickerNotice({ loading: true, error: null, items: [], shown: [] })?.text).toBe("Loading agents…");
    expect(pickerNotice({ loading: false, error: "boom", items: [], shown: [] })).toEqual({ tone: "error", text: "Agents could not be loaded. boom" });
    expect(pickerNotice({ loading: false, error: null, items: [], shown: [] })?.text).toMatch(/No agents yet/);
    const archived = [agent({ unavailable_reason: "archived" })];
    expect(pickerNotice({ loading: false, error: null, items: archived, shown: archived })?.text).toMatch(/All agents are archived/);
    expect(pickerNotice({ loading: false, error: null, items, shown: [] })?.text).toBe("No agents match.");
    expect(pickerNotice({ loading: false, error: null, items, shown: items })).toBeNull();
  });

  it("preselects only agents that can be picked", () => {
    expect(findAgent(items, "triage")?.id).toBe("triage");
    expect(findAgent(items, "nope")).toBeNull();
    expect(findAgent(items, undefined)).toBeNull();
    expect(findAgent([agent({ unavailable_reason: "archived" })], "support")).toBeNull();
  });
});
