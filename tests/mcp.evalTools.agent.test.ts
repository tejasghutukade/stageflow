import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEvalHarness, realEvalYaml, type AgentEvalHarness } from "./helpers/agentEvalHarness.js";

const open: AgentEvalHarness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function setup(opts: Parameters<typeof agentEvalHarness>[0] = {}): Promise<AgentEvalHarness> {
  const h = await agentEvalHarness(opts);
  open.push(h);
  return h;
}

const REAL = realEvalYaml("real-ok", "  mode: script\n  tools: real\n  allow_real_tools: true\n  approvals: deny\n");
const MOCKED = realEvalYaml("mocked-deny", "  mode: script\n  tools: mocked\n  approvals: deny\n");

async function listTools(base: string): Promise<Array<{ name: string; description: string; inputSchema: any }>> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  return JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result.tools;
}

describe("MCP eval tools with agent targets", () => {
  it("states model cost, simulator and read-only tools on run_eval and exposes the new inputs", async () => {
    const h = await setup();
    const tools = await listTools(h.base);
    const runEval = tools.find((t) => t.name === "run_eval")!;
    expect(runEval.description).toMatch(/agent's model/i);
    expect(runEval.description).toMatch(/simulator/i);
    expect(runEval.description).toMatch(/judge/i);
    expect(runEval.description).toMatch(/much more than stage runs/i);
    expect(runEval.description).toMatch(/read-only by default/i);
    expect(runEval.description).toMatch(/EVAL_REAL_TOOLS_NOT_CONFIRMED/);
    expect(Object.keys(runEval.inputSchema.properties)).toEqual(
      expect.arrayContaining(["user_model", "allow_real_tools", "tools", "approvals", "model"]),
    );
    expect(runEval.inputSchema.properties.model.description).toMatch(/stage or agent/);
    const evalTools = tools.filter((t) => /eval/.test(t.name)).map((t) => t.name).sort();
    expect(evalTools).toEqual(
      [
        "accept_eval_failure_suggestions",
        "calibrate_eval_grader",
        "cancel_eval_run",
        "compare_eval_runs",
        "create_eval",
        "delete_eval_run",
        "dismiss_eval_failure_suggestions",
        "get_eval",
        "get_eval_failure_sort_status",
        "get_eval_failure_suggestions",
        "get_eval_result",
        "get_eval_results",
        "get_eval_run",
        "get_eval_run_export",
        "install_eval_sample",
        "list_eval_runs",
        "list_evals",
        "put_eval_review",
        "run_eval",
        "sort_eval_failures",
        "try_eval_case",
        "update_eval",
        "validate_eval",
      ].sort(),
    );
  });

  it("returns agent targets from list_evals and get_eval exactly as the API does", async () => {
    const h = await setup();
    const listed = await h.tool("list_evals", { project_root: h.root });
    expect(listed.isError).toBe(false);
    const api = await h.get(`/api/evals?${h.q}`);
    expect(listed.payload.items).toEqual(api.body.items);
    const agentItem = listed.payload.items.find((i: any) => i.id === "script-basics");
    expect(agentItem.target).toMatchObject({ kind: "agent", agent_id: "support", agent_name: "Support" });
    expect(agentItem.conversation).toMatchObject({ mode: "script", tools: "read_only" });

    const detail = await h.tool("get_eval", { eval_id: "script-basics", project_root: h.root });
    expect(detail.payload).toEqual((await h.get(`/api/evals/script-basics?${h.q}`)).body);
    expect(detail.payload.agent).toMatchObject({ id: "support", ask_first: ["billing.refund"] });
    const stage = await h.tool("get_eval", { eval_id: "review", project_root: h.root });
    expect(stage.payload).not.toHaveProperty("agent");
  });

  it("validates agent eval yaml with the agent catalog and writes no files", async () => {
    const h = await setup();
    const yaml = await readFile(path.join(h.root, "evals", "script-basics.eval.yaml"), "utf8");
    const ok = await h.tool("validate_eval", { yaml, project_root: h.root });
    expect(ok.isError).toBe(false);
    expect(ok.payload.findings.filter((f: any) => f.severity === "error")).toEqual([]);
    const ghost = await h.tool("validate_eval", { yaml: yaml.replace("agent: support", "agent: ghost"), project_root: h.root });
    expect(ghost.payload.findings.map((f: any) => f.code)).toContain("eval.agent_not_found");
    const real = await h.tool("validate_eval", { yaml: yaml.replace("tools: read_only", "tools: real"), project_root: h.root });
    expect(real.payload.findings.map((f: any) => f.code)).toContain("eval.real_tools_not_allowed");
  });

  it("runs an agent eval and returns the finished detail and the conversation subject", async () => {
    const h = await setup();
    const res = await h.tool("run_eval", { eval_id: "script-basics", project_root: h.root, wait: true, repeats: 1 });
    expect(res.isError).toBe(false);
    expect(res.payload.status).toBe("completed");
    expect(res.payload.stats.mean_turns).toBeGreaterThan(0);
    expect(res.payload).toEqual((await h.get(`/api/eval-runs/${res.payload.eval_run_id}`)).body);
    expect((await h.store.getEvalRun(res.payload.eval_run_id))?.startedVia).toBe("mcp");

    const result = await h.tool("get_eval_result", { eval_run_id: res.payload.eval_run_id, case_id: "t1" });
    expect(result.isError).toBe(false);
    expect(result.payload.repeats[0].output.kind).toBe("conversation");
    expect(result.payload).toEqual((await h.get(`/api/eval-runs/${res.payload.eval_run_id}/results/t1`)).body);
    const rows = await h.tool("get_eval_results", { eval_run_id: res.payload.eval_run_id });
    expect(rows.payload.items[0]).toHaveProperty("turns");
  });

  it("applies the same real-tools consent and safer-only rules as the API", async () => {
    const h = await setup({ extraFiles: { "evals/real-ok.eval.yaml": REAL, "evals/mocked-deny.eval.yaml": MOCKED } });
    const refused = await h.tool("run_eval", { eval_id: "real-ok", project_root: h.root });
    expect(refused.isError).toBe(true);
    expect(refused.payload.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    const viaApi = await h.post("/api/evals/real-ok/runs", { project_root: h.root });
    expect(refused.payload.code).toBe(viaApi.body.code);
    expect(await h.store.listEvalRuns({ evalId: "real-ok", limit: 5 })).toMatchObject({ items: [] });

    const allowed = await h.tool("run_eval", { eval_id: "real-ok", project_root: h.root, allow_real_tools: true, wait: true });
    expect(allowed.isError).toBe(false);
    expect(allowed.payload.config.settings.conversation).toMatchObject({ tools: "real", real_tools_confirmed: true });

    const riskier = await h.tool("run_eval", { eval_id: "mocked-deny", project_root: h.root, tools: "read_only" });
    expect(riskier.isError).toBe(true);
    expect(riskier.payload.code).toBe("EVAL_INVALID");
    const stage = await h.tool("run_eval", { eval_id: "review", project_root: h.root, user_model: "a/b" });
    expect(stage.isError).toBe(true);
    expect(stage.payload.code).toBe("EVAL_INVALID");
  });
});
