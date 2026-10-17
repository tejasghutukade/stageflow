import { describe, expect, it } from "vitest";
import {
  grantedToolIds,
  parseAgentDefinition,
  parseAgentYaml,
  serializeAgentDefinition,
} from "../src/config/loadAgent.js";

describe("agent definition v2", () => {
  it("fills every default from the three required fields", () => {
    const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help." });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      enabled: false,
      execution: "trusted-local",
      project_context: false,
      model: { backend: "pi", thinking: "medium" },
      tools: { builtin: [], mcp: {}, skills: [], browser: false },
      approvals: {
        ask_first: [],
        approvers: { operators: true, channel_ids: [] },
        timeout_minutes: 30,
        on_timeout: "skip",
      },
      sub_agents: [],
      sub_agent_depth: 1,
      observability: { capture: "metadata", otlp: false },
      limits: { session_minutes: 10, max_turns: 40, cost_usd: null, long_context: "summarize" },
    });
  });

  it("reports field-level issues with dotted paths", () => {
    const parsed = parseAgentDefinition({
      id: "Bad-Id",
      name: " ",
      instructions: "x",
      tools: { builtin: ["read", "teleport"] },
      approvals: { approvers: { operators: false } },
      schedule: { cron: "every tuesday" },
      surprise: true,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const byPath = Object.fromEntries(parsed.issues.map((issue) => [issue.path, issue.code]));
    expect(byPath).toMatchObject({
      id: "agent.invalid_format",
      name: "agent.required",
      "tools.builtin.1": "agent.invalid_value",
      "approvals.approvers": "agent.invalid_value",
      "schedule.cron": "agent.invalid_value",
      "": "agent.unknown_field",
    });
  });

  it("refuses ask-first on a tool the agent is not granted, and self-delegation", () => {
    const parsed = parseAgentDefinition({
      id: "poster",
      name: "Poster",
      instructions: "Post.",
      tools: { mcp: { slack: ["post_message"] } },
      approvals: { ask_first: ["slack.post_message", "bash"] },
      sub_agents: ["poster"],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ["approvals.ask_first.1", "agent.ask_first_not_granted"],
      ["sub_agents", "agent.sub_agent_self"],
    ]);
  });

  it("allows ask-first on a tool of a wildcard MCP grant", () => {
    const parsed = parseAgentDefinition({
      id: "poster",
      name: "Poster",
      instructions: "Post.",
      tools: { mcp: { slack: ["*"] } },
      approvals: { ask_first: ["slack.post_message"] },
    });
    expect(parsed.ok).toBe(true);
  });

  it("serializes canonically: defaults omitted, round-trips to the same definition", () => {
    const parsed = parseAgentDefinition({
      id: "research",
      name: "Research",
      instructions: "Find sources.\nCite them.",
      tools: { builtin: ["read"], mcp: { notion: ["search"] } },
      limits: { cost_usd: 0.25 },
    });
    if (!parsed.ok) throw new Error("expected valid");
    const yaml = serializeAgentDefinition(parsed.value);
    expect(yaml).toBe(
      [
        "id: research",
        "name: Research",
        "enabled: false",
        "instructions: |",
        "  Find sources.",
        "  Cite them.",
        "tools:",
        "  builtin:",
        "    - read",
        "  mcp:",
        "    notion:",
        "      - search",
        "limits:",
        "  cost_usd: 0.25",
        "",
      ].join("\n"),
    );
    const again = parseAgentYaml(yaml);
    expect(again.ok && serializeAgentDefinition(again.value)).toBe(yaml);
  });

  it("reports YAML syntax errors with a position", () => {
    const parsed = parseAgentYaml("id: x\nname: [unclosed\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]).toMatchObject({ path: "", code: "agent.yaml_syntax" });
    expect(parsed.issues[0]!.line).toBeGreaterThan(0);
  });

  it("lists granted tool ids across builtin groups, MCP servers and sub-agents", () => {
    const parsed = parseAgentDefinition({
      id: "lead",
      name: "Lead",
      instructions: "Lead.",
      tools: { builtin: ["read", "shell"], mcp: { github: ["create_issue"] } },
      sub_agents: ["helper"],
    });
    if (!parsed.ok) throw new Error("expected valid");
    expect([...grantedToolIds(parsed.value)].sort()).toEqual(
      ["agent:helper", "bash", "find", "github.create_issue", "grep", "ls", "read"].sort(),
    );
  });
});
