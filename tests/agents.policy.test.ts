import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertDelegateAllowed } from "../src/agents/delegate.js";
import { checkGuardrails } from "../src/agents/guardrails.js";
import { canApprove, effectiveAskFirst, isToolGranted, isWritePathForbidden, requiresAskFirst } from "../src/agents/policy.js";
import { createFakeSandboxRunner, prepareExecutionLaunch } from "./helpers/agentsSandbox.js";
import { parseAgentDefinition, type AgentDefinition } from "../src/config/loadAgent.js";

function definition(overrides: Record<string, unknown> = {}): AgentDefinition {
  const parsed = parseAgentDefinition({ id: "lead", name: "Lead", instructions: "Lead.", ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

describe("agent policy", () => {
  it("grants builtin groups, listed MCP tools, wildcard servers, and sub-agents only", () => {
    const lead = definition({
      tools: { builtin: ["read"], mcp: { notion: ["search"], github: ["*"] } },
      sub_agents: ["helper"],
    });
    for (const tool of ["read", "grep", "ls", "find", "notion.search", "github.merge", "agent:helper"]) {
      expect(isToolGranted(lead, tool), tool).toBe(true);
    }
    for (const tool of ["bash", "write", "notion.delete", "agent:other", "slack.post_message"]) {
      expect(isToolGranted(lead, tool), tool).toBe(false);
    }
  });

  it("knows which tools ask first and who may approve", () => {
    const poster = definition({
      tools: { mcp: { slack: ["post_message"] } },
      approvals: { ask_first: ["slack.post_message"], approvers: { operators: false, channel_ids: ["slack:U1"] } },
    });
    expect(requiresAskFirst(poster, "slack.post_message")).toBe(true);
    expect(canApprove(poster, { kind: "operator" })).toBe(false);
    expect(canApprove(poster, { kind: "channel", channelId: "slack:U1" })).toBe(true);
  });

  it("always asks before bash, even when ask_first does not list it", () => {
    const shell = definition({ tools: { builtin: ["write"], builtin_tools: ["bash"] }, approvals: { ask_first: ["write"] } });
    expect(requiresAskFirst(shell, "bash")).toBe(true);
    expect(effectiveAskFirst(shell)).toEqual(["write", "bash"]);
    const noShell = definition({ tools: { builtin: ["read"] } });
    expect(effectiveAskFirst(noShell)).toEqual([]);
    expect(requiresAskFirst(noShell, "read")).toBe(false);
  });

  it("never lets an agent write agent definitions or Stageflow state", () => {
    const project = path.resolve("/work/project");
    const home = path.resolve("/home/me/.stageflow");
    expect(isWritePathForbidden(project, home, path.join(project, "agents", "lead.agent.yaml"))).toBe(true);
    expect(isWritePathForbidden(project, home, path.join(home, "state.db"))).toBe(true);
    expect(isWritePathForbidden(project, home, path.join(project, "agents", "notes.md"))).toBe(false);
    expect(isWritePathForbidden(project, home, path.join(project, "src", "index.ts"))).toBe(false);
  });

  it("allows a project that lives under the Stageflow home, but not the state beside it", () => {
    const home = path.resolve("/data");
    const project = path.join(home, "workspace");
    expect(isWritePathForbidden(project, home, path.join(project, "notes", "a.txt"))).toBe(false);
    expect(isWritePathForbidden(project, home, path.join(project, "agents", "lead.agent.yaml"))).toBe(true);
    expect(isWritePathForbidden(project, home, path.join(home, "state.db"))).toBe(true);
    expect(isWritePathForbidden(project, home, path.join(project, "..", "state.db"))).toBe(true);
  });

  it("limits delegation to listed sub-agents within the depth", () => {
    const lead = definition({ sub_agents: ["helper"], sub_agent_depth: 2 });
    expect(() => assertDelegateAllowed(lead, "helper", 0)).not.toThrow();
    expect(() => assertDelegateAllowed(lead, "helper", 2)).toThrow(expect.objectContaining({ code: "agent.delegate_depth_exceeded" }));
    expect(() => assertDelegateAllowed(lead, "other", 0)).toThrow(expect.objectContaining({ code: "agent.delegate_not_allowed" }));
  });

  it("blocks replies that match a guardrail pattern", () => {
    const guarded = definition({ guardrails: { block_patterns: ["[Pp]assword", "secret-\\d+"] } });
    expect(checkGuardrails(guarded.guardrails, "here is secret-42")).toEqual({ ok: false, pattern: "secret-\\d+" });
    expect(checkGuardrails(guarded.guardrails, "all clear")).toEqual({ ok: true });
  });

  it("refuses to run a sandboxed agent without a sandbox, instead of falling back", async () => {
    const sandboxed = definition({ execution: "sandbox" });
    await expect(prepareExecutionLaunch(sandboxed, "/p", undefined)).rejects.toMatchObject({
      code: "agent.sandbox_unavailable",
    });
    expect(await prepareExecutionLaunch(sandboxed, "/p", createFakeSandboxRunner("sbx"))).toEqual({
      mode: "sandbox",
      ref: "sbx",
    });
    expect(await prepareExecutionLaunch(definition(), "/p", undefined)).toEqual({ mode: "trusted-local" });
  });
});
