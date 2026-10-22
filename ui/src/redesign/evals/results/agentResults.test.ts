import { describe, expect, it } from "vitest";
import type { EvalRunDetail } from "../../../api/evalTypes";
import { agentIdOf, agentNameOf, agentRevisionOf, agentRunLabel, isAgentRun } from "../agentRun";
import { agentFailureLabel, buildRows, liveSubtitle, nowText } from "../run/liveProgressModel";
import { caseRowView } from "./casesModel";
import {
  agentCard,
  agentEdited,
  agentRevisionChip,
  agentToolRows,
  conversationCard,
  limitsLine,
  reproduceCommand,
  rerunNote,
  rerunOverrides,
  settingsCard,
  toolOutcome,
  usedRealTools,
} from "./configModel";
import { fixtureRow, fixtureRun, fixtureStats } from "./fixtures";
import { footerText, headerSubtitle } from "./headerModel";
import { kpiTiles } from "./overviewModel";

function agentRun(overrides: Partial<EvalRunDetail> = {}, conversation: Record<string, unknown> = {}): EvalRunDetail {
  const base = fixtureRun();
  return {
    ...base,
    eval_id: "support-eval",
    eval_path: "evals/support-eval.eval.yaml",
    config: {
      ...base.config,
      target: {
        kind: "agent",
        agent_id: "support",
        revision: 4,
        definition_hash: "a1b2c3d4e5f6",
        definition: { name: "Support" },
        model: "anthropic/claude-sonnet-4-5",
        tools: [
          { id: "read", risk: "read", class: "read" },
          { id: "bash", risk: "write", class: "shell" },
          { id: "billing.lookup_invoice", risk: "unknown", class: "mcp_unknown" },
          { id: "billing.refund", risk: "unknown", class: "mcp_unknown" },
          { id: "stageflow.get_agent", risk: "read", class: "operator_only" },
        ],
        ask_first: ["billing.refund"],
        sub_agents: [{ id: "helper", revision: 2 }],
        limits_override: { agent: { max_turns: 40 }, effective: { max_turns: 9, session_minutes: 22 } },
      },
      settings: {
        ...base.config.settings,
        judge: "anthropic/claude-sonnet-4-5",
        judge_same_as_stage: true,
        conversation: {
          mode: "simulated",
          max_turns: 8,
          turn_timeout_ms: 120000,
          tools: "read_only",
          approvals: "record_only",
          read_only_tools: ["billing.lookup_invoice"],
          user_model: "anthropic/claude-sonnet-4-5",
          simulator_prompt_version: 1,
          ...conversation,
        },
      },
      engine: { ...base.config.engine, rubric_prompt_version: 2 },
    },
    stats: fixtureStats({ mean_turns: 3.4, mean_tool_calls: 2.25 }),
    current: { ...base.current, agent_revision: 4, agent_definition_hash: "a1b2c3d4e5f6" },
    ...overrides,
  };
}

describe("agent run snapshot helpers", () => {
  it("reads the agent from the snapshot", () => {
    const run = agentRun();
    expect(isAgentRun(run)).toBe(true);
    expect(agentIdOf(run)).toBe("support");
    expect(agentRevisionOf(run)).toBe(4);
    expect(agentNameOf(run)).toBe("Support");
    expect(agentRunLabel(run)).toBe("Agent Support r4");
    expect(isAgentRun(fixtureRun())).toBe(false);
    expect(agentRunLabel(fixtureRun())).toBeNull();
  });

  it("falls back to the id when the definition has no name", () => {
    const run = agentRun();
    run.config.target.definition = {};
    expect(agentNameOf(run)).toBe("support");
  });
});

describe("results header and overview", () => {
  it("writes the agent subtitle with scenarios, judge and user model", () => {
    const text = headerSubtitle(agentRun(), Date.parse("2026-10-20T10:05:00Z"));
    expect(text).toBe("Agent Support r4 · review-diffs, 24 scenarios × 3 repeats · judge anthropic/claude-sonnet-4-5 · user anthropic/claude-sonnet-4-5 · finished 5m in 3 m 41 s");
  });

  it("keeps the stage subtitle", () => {
    expect(headerSubtitle(fixtureRun(), Date.parse("2026-10-20T10:05:00Z"))).toContain("Stage review in feature-ship");
  });

  it("names the agent definition in the footer", () => {
    expect(footerText(agentRun())).toBe("Agent definition a1b2c3 · eval file evals/support-eval.eval.yaml · stored on this machine");
    expect(footerText(fixtureRun())).toContain("Stage version 3f9a1c");
  });

  it("adds Turns and Tool calls tiles from the API values, and splits the cost line", () => {
    const tiles = kpiTiles(agentRun());
    expect(tiles.map((t) => t.id)).toEqual(["pass", "score", "reliability", "turns", "tool_calls", "latency", "cost", "tokens"]);
    expect(tiles.find((t) => t.id === "turns")).toMatchObject({ label: "Turns", value: "3.4", sub: "per conversation" });
    expect(tiles.find((t) => t.id === "tool_calls")).toMatchObject({ label: "Tool calls", value: "2.3", sub: "per conversation" });
    expect(tiles.find((t) => t.id === "cost")?.sub).toBe("$0.01 per result · agent and simulator $0.53 · judge $0.11");
  });

  it("hides the tiles when the API has no value", () => {
    const run = agentRun({ stats: fixtureStats({ mean_turns: null, mean_tool_calls: null }) });
    expect(kpiTiles(run).map((t) => t.id)).not.toContain("turns");
    expect(kpiTiles(run).map((t) => t.id)).not.toContain("tool_calls");
  });

  it("leaves stage runs with the six tiles", () => {
    expect(kpiTiles(fixtureRun()).map((t) => t.id)).toEqual(["pass", "score", "reliability", "latency", "cost", "tokens"]);
    expect(kpiTiles(fixtureRun({ stats: fixtureStats({ mean_turns: 2 }) })).map((t) => t.id)).not.toContain("turns");
  });
});

describe("cases table", () => {
  it("adds mean turns and tool calls per case for agent rows", () => {
    expect(caseRowView(fixtureRow({ turns: 4, tool_calls: 2.5 }), 0.8)).toMatchObject({ turnsText: "4", toolsText: "2.5" });
    expect(caseRowView(fixtureRow({ turns: null, tool_calls: null }), 0.8)).toMatchObject({ turnsText: "—", toolsText: "—" });
    expect(caseRowView(fixtureRow(), 0.8)).not.toHaveProperty("turnsText");
  });
});

describe("agent config cards", () => {
  it("shows the agent, its revision and definition hash", () => {
    expect(agentCard(agentRun())).toEqual([
      { label: "Agent", value: "Support · support" },
      { label: "Revision", value: "r4" },
      { label: "Definition", value: "a1b2c3" },
      { label: "Model", value: "anthropic/claude-sonnet-4-5" },
      { label: "Asks first", value: "billing.refund" },
      { label: "Limits", value: "Eval limits replaced the agent's: 9 turns, 22 minutes" },
      { label: "Sub-agents", value: "helper r2" },
    ]);
  });

  it("flags an agent edited since the run", () => {
    const run = agentRun({ current: { stage_version_hash: null, dataset_hash: null, grader_hashes: null, agent_revision: 6, agent_definition_hash: "ffffffffffff" } });
    expect(agentRevisionChip(run)).toEqual({ text: "edited since: now r6", tone: "needs" });
    expect(agentEdited(run)).toBe(true);
    const rows = agentCard(run);
    expect(rows[1]?.chip).toEqual({ text: "edited since: now r6", tone: "needs" });
    expect(rows[2]?.chip).toEqual({ text: "edited since: now ffffff", tone: "needs" });
    expect(agentEdited(agentRun())).toBe(false);
    expect(agentRevisionChip(agentRun())).toBeNull();
  });

  it("notes what a re-run would pick up", () => {
    const run = agentRun({ current: { stage_version_hash: null, dataset_hash: null, grader_hashes: null, agent_revision: 5 } });
    expect(rerunNote(run)).toBe("The agent changed since this run; this will use the current ones.");
    expect(rerunNote(agentRun())).toBeNull();
  });

  it("gives each tool the outcome its policy decides", () => {
    const rows = agentToolRows(agentRun());
    const outcome = Object.fromEntries(rows.map((r) => [r.id, r.outcome]));
    expect(outcome).toEqual({
      read: "Ran",
      bash: "Would ask first",
      "billing.lookup_invoice": "Ran",
      "billing.refund": "Would ask first",
      "stageflow.get_agent": "Denied",
    });
    expect(rows[1]).toMatchObject({ cls: "shell", tone: "needs" });
    expect(rows[2]).toMatchObject({ cls: "unknown MCP", tone: "ok" });
  });

  it("applies the decision table", () => {
    const conv = { tools: "read_only", approvals: "record_only", read_only_tools: [] as string[] };
    expect(toolOutcome({ id: "edit", class: "write" }, conv, [])).toEqual({ label: "Stubbed, Mocked if the scenario mocks it", tone: "muted" });
    expect(toolOutcome({ id: "edit", class: "write" }, { ...conv, tools: "real" }, [])).toEqual({ label: "Ran", tone: "ok" });
    expect(toolOutcome({ id: "read", class: "read" }, conv, ["read"])).toEqual({ label: "Would ask first", tone: "needs" });
    expect(toolOutcome({ id: "read", class: "read" }, { ...conv, approvals: "auto_approve_read" }, ["read"])).toEqual({ label: "Ran", tone: "ok" });
    expect(toolOutcome({ id: "edit", class: "write" }, { ...conv, approvals: "auto_approve_read" }, ["edit"])).toEqual({ label: "Would ask first", tone: "needs" });
    expect(toolOutcome({ id: "read", class: "read" }, { ...conv, approvals: "deny" }, ["read"])).toEqual({ label: "Denied", tone: "fail" });
    expect(toolOutcome({ id: "x.*", class: "mcp_unknown" }, { ...conv, read_only_tools: ["x.*"] }, [])).toEqual({ label: "Ran", tone: "ok" });
  });

  it("describes the conversation settings, simulator and rubric prompt versions", () => {
    const rows = Object.fromEntries(conversationCard(agentRun()).map((r) => [r.label, r.value]));
    expect(rows).toEqual({
      Mode: "Simulated",
      "Max turns": "8",
      "Turn timeout": "120 s",
      Tools: "Read only",
      Approvals: "Record only",
      "Read-only tools": "billing.lookup_invoice",
      "User model": "anthropic/claude-sonnet-4-5",
      "Simulator prompt": "v1",
      "Conversation rubric prompt": "v2",
    });
    const real = conversationCard(agentRun({}, { tools: "real" }));
    expect(real.find((r) => r.label === "Tools")?.chip).toEqual({ text: "REAL TOOLS", tone: "needs" });
  });

  it("shows no limits row when the snapshot has none", () => {
    const run = agentRun();
    delete run.config.target.limits_override;
    expect(limitsLine(run)).toBeNull();
  });

  it("calls the model override the agent model", () => {
    const run = agentRun();
    run.config.overrides = { model: "x/y" };
    expect(settingsCard(run).find((r) => r.label === "Suite type")?.value).toBe("capability · agent model overridden: x/y");
    expect(settingsCard(run)[0]?.chip?.text).toBe("same as agent model");
    expect(settingsCard(fixtureRun())[0]?.chip?.text).toBe("same as stage model");
  });
});

describe("re-running an agent configuration", () => {
  it("adds --allow-real-tools and --user-model to the reproduce command", () => {
    const real = agentRun({}, { tools: "real" });
    real.config.overrides = { user_model: "openai/gpt-5", max_cost_usd: null };
    expect(usedRealTools(real)).toBe(true);
    expect(reproduceCommand(real)).toBe("sf eval run evals/support-eval.eval.yaml --repeats 3 --judge anthropic/claude-sonnet-4-5 --user-model openai/gpt-5 --allow-real-tools");
    expect(reproduceCommand(agentRun())).not.toContain("--allow-real-tools");
    expect(usedRealTools(fixtureRun())).toBe(false);
  });

  it("repeats the safer overrides", () => {
    const run = agentRun();
    run.config.overrides = { user_model: "openai/gpt-5", tools: "mocked", approvals: "deny", model: null };
    expect(rerunOverrides(run)).toMatchObject({ user_model: "openai/gpt-5", tools: "mocked", approvals: "deny" });
    run.config.overrides = { tools: "real" };
    expect(rerunOverrides(run)).not.toHaveProperty("tools");
  });
});

describe("live progress for agents", () => {
  it("says the agent is talking", () => {
    expect(nowText({ case_id: "c", repeat_index: 2, phase: "agent_running" }, false)).toEqual({ text: "Agent is talking, repeat 3", tone: "running" });
    expect(nowText({ case_id: "c", repeat_index: 2, phase: "grading" }, false).text).toBe("Judge is grading repeat 3");
    expect(nowText({ case_id: "c", repeat_index: 0, phase: "stage_running" }, false).text).toBe("Stage is running repeat 1");
    expect(nowText(undefined, true)).toEqual({ text: "Done", tone: "muted" });
  });

  it("labels a failed agent repeat", () => {
    expect(agentFailureLabel(["completed", "stage_failed"])).toBe("Agent failed");
    expect(agentFailureLabel(["error"])).toBe("Error");
    expect(agentFailureLabel(["completed"])).toBeNull();
    expect(nowText(undefined, true, "Agent failed")).toEqual({ text: "Agent failed", tone: "fail" });
  });

  it("shows the failure on a finished row of an agent run only", () => {
    const rows = [
      { case_id: "c1", position: 1, title: "Refund", tags: [], repeats: [{ repeat_index: 0, status: "stage_failed" as const, passed: false, score: null }], pass_fraction: null, mean_score: null, failed_graders: [], latency_ms_p50: null, cost_usd: 0, failure_tags: [] },
    ];
    const run = agentRun({ config: { ...agentRun().config, settings: { repeats: 1, pass_threshold: 0.8 } } });
    expect(buildRows({ run, rows, cases: null })[0]).toMatchObject({ nowText: "Agent failed", nowTone: "fail", dots: ["failed"] });
    const stage = fixtureRun({ config: { ...fixtureRun().config, settings: { repeats: 1, pass_threshold: 0.8 } } });
    expect(buildRows({ run: stage, rows, cases: null })[0]).toMatchObject({ nowText: "Done", nowTone: "muted" });
  });

  it("starts the subtitle with the agent", () => {
    const run = agentRun({ started_at: "2026-10-20T10:00:00Z", finished_at: null });
    expect(liveSubtitle(run, Date.parse("2026-10-20T10:00:30Z"))).toBe("Agent Support r4 · review-diffs, 24 cases × 3 repeats · started 30.0 s ago");
  });
});
