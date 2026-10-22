import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalCommand } from "../src/cli/evalCommand.js";
import type { FakeTurnScript } from "../src/evals/runner/FakeAgentBackend.js";
import type { CompleteInput } from "../src/agents/runtime/types.js";
import { agentEvalHarness, realEvalYaml, type AgentEvalHarness } from "./helpers/agentEvalHarness.js";
import { alreadyUp } from "./helpers/testInProcessService.js";

const MANIFEST = "version: 1\nmodel: anthropic/claude-haiku-4-5\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n";

const open: AgentEvalHarness[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const h of open.splice(0)) await h.close();
});

/**
 * Scripted agent for the 6 sample scenarios x 2 repeats. The agent answers by what the user said last, so the result
 * does not depend on the order the engine runs the cases in:
 *  - s001 "Free plan": the first repeat states the limit (3), the second does not (flaky); `stable` makes both state it.
 *  - s002 refund, s003 two-turn clarify, s006 README: always pass.
 *  - s004 tries `write` and `bash`, which read_only must block (forbidden-tool violation, every repeat).
 *  - s005 never answers (turn timeout, every repeat).
 */
function sampleAgent(state: { stable: boolean }) {
  const asked = new Map<string, number>();
  return (input: CompleteInput): FakeTurnScript => {
    const said = input.messages.at(-1)!.text;
    const nth = (asked.get(said) ?? 0) + 1;
    asked.set(said, nth);
    if (said.startsWith("How many notebooks")) {
      return { text: nth === 1 || state.stable ? "The Free plan allows up to 3 notebooks." : "The Free plan has a notebook limit." };
    }
    if (said.startsWith("I bought Pro")) return { text: "Refunds work within 14 days: email billing@notely.example." };
    if (said === "It does not work.") return { text: "Which part of the app is failing for you?" };
    if (said === "When I press export.") return { text: "Export lives under Settings, then Export." };
    if (said.startsWith("Please save a summary")) {
      return {
        text: "I cannot save files.",
        tools: [
          { tool: "write", input: { path: "notes.txt", content: "summary" }, body: () => "wrote notes.txt" },
          { tool: "bash", input: { command: "echo summary > notes.txt" }, body: () => "ran shell" },
        ],
      };
    }
    if (said.startsWith("Can you tell me if")) return { hang: true };
    if (said.startsWith("What does README.md")) {
      return { text: "The README explains installation in two steps.", tools: [{ tool: "read", input: { path: "README.md" }, body: () => "# Notely" }] };
    }
    return { text: "ok" };
  };
}

async function setup(state = { stable: false }): Promise<AgentEvalHarness> {
  const h = await agentEvalHarness({ script: sampleAgent(state) as never });
  open.push(h);
  await writeFile(path.join(h.root, "stageflow.yaml"), MANIFEST);
  const installed = await h.post("/api/evals/sample", { project_root: h.root, kind: "agent" });
  expect(installed.status).toBe(201);
  expect(installed.body.eval_id).toBe("support-sample");
  // The shortest allowed turn timeout (5 s) keeps the timeout scenario quick.
  const file = path.join(h.root, "evals", "support-sample.eval.yaml");
  await writeFile(file, (await readFile(file, "utf8")).replace("  max_turns: 4\n", "  max_turns: 4\n  turn_timeout_ms: 5000\n"));
  return h;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The real eval routes behind a one-route project endpoint, so the CLI talks to real handlers. */
async function cliFor(h: AgentEvalHarness) {
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.method === "POST" && req.url === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ project_root: h.root }));
      return;
    }
    const upstream = await fetch(`${h.base}${req.url}`, {
      method: req.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(raw.length > 0 ? { body: raw } : {}),
    });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEvalCommand(args, {
      cwd: h.root,
      io: { log: (l) => out.push(l), error: (l) => err.push(l) },
      hostBaseUrl: baseUrl,
      ensureService: alreadyUp,
      pollIntervalMs: 5,
      stderrIsTTY: false,
    });
    return { code, out, err, doc: () => JSON.parse(out.join("\n")) };
  };
}

describe("agent evals end to end (in-process Host, fake engine, fake agent backend)", () => {
  it("installs the sample, runs, compares after an agent edit, reviews and deletes, with every number hand-computed", async () => {
    const state = { stable: false };
    const h = await setup(state);

    const validated = await h.post("/api/evals/validate", {
      project_root: h.root,
      path: "evals/support-sample.eval.yaml",
      yaml: await readFile(path.join(h.root, "evals", "support-sample.eval.yaml"), "utf8"),
    });
    expect(validated.status).toBe(200);
    expect(validated.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);

    const list = await h.get(`/api/evals?${h.q}&target_kind=agent`);
    expect(list.body.items.find((i: any) => i.id === "support-sample")).toMatchObject({
      valid: true,
      dataset_cases: 6,
      grader_count: 5,
      repeats: 2,
      status: "never_run",
    });

    // Operator-facing state before the run.
    const before = {
      approvals: await h.service.pendingApprovals(h.root, { includeEval: true }),
      sessions: (await h.service.listAllSessions(h.root, { limit: 50 } as never)).sessions.length,
      stats: (await h.service.listAllSessions(h.root, { limit: 50 } as never)).stats,
    };

    const first = await h.run("support-sample", { label: "baseline" });
    const run1 = (await h.get(`/api/eval-runs/${first}`)).body;
    expect(run1).toMatchObject({ status: "completed", run_number: 1, label: "baseline", passed: false });

    // 6 cases x 2 repeats = 12 results.
    //  s001: repeat A states the limit (passes), repeat B does not (mentions-the-fact, weight 3 of 7, fails: 4/7 < 0.8)
    //  s002, s003, s006: both repeats pass (6)
    //  s004: write and bash are blocked and recorded, no-forbidden-tools must_pass fails (2 fails)
    //  s005: no answer within 5 s, stage_failed / EVAL_AGENT_TIMEOUT (2 fails)
    // passed = 1 + 6 = 7 of 12 executed. Timeouts count as executed.
    expect(run1.stats).toMatchObject({
      cases_counted: 6,
      results_executed: 12,
      results_passed: 7,
      errored: 0,
      pass_rate: 7 / 12,
      // repeated cases: 6; passed in every repeat: s002, s003, s006 -> 3/6; passed in at least one: + s001 -> 4/6
      reliability: 0.5,
      pass_any: 4 / 6,
      flaky_cases: ["s001"],
    });
    // Turns per executed result: s001 1,1  s002 1,1  s003 2,2  s004 1,1  s006 1,1 = 12, and each timeout reports its one
    // unfinished turn = 2 more -> 14 / 12. Tool calls: s004 attempts write and bash (2,2), s006 reads once (1,1) = 6 / 12.
    expect(run1.stats.mean_turns).toBeCloseTo(14 / 12, 10);
    expect(run1.stats.mean_tool_calls).toBeCloseTo(0.5, 10);
    // Backend usage is 0.01 per model call: s001 2 calls, s002 2, s003 4, s004 2, s006 2 and the 2 timed-out turns = 14.
    expect(run1.stats.cost_stage).toBeCloseTo(0.14, 10);
    expect(run1.stats.cost_judge).toBe(0);
    // By grader: the timeouts have no grades, so 10 results are graded.
    const grader = (id: string) => run1.stats.by_grader.find((g: any) => g.grader_id === id);
    expect(grader("no-forbidden-tools")).toMatchObject({ graded: 10, passed: 8 });
    expect(grader("mentions-the-fact")).toMatchObject({ graded: 10, passed: 9 });
    expect(grader("reads-files-when-asked")).toMatchObject({ graded: 10, passed: 10 });
    expect(run1.stats.failing_cases.map((c: any) => c.case_id)).toEqual(["s005", "s004", "s001"]);

    const rows1 = (await h.get(`/api/eval-runs/${first}/results`)).body;
    expect(rows1.counts).toMatchObject({ all: 6, passed: 3, failed: 3, flaky: 1 });
    const timeout = (await h.get(`/api/eval-runs/${first}/results/s005`)).body.repeats[0];
    expect(timeout).toMatchObject({ status: "stage_failed", error_code: "EVAL_AGENT_TIMEOUT" });
    const violation = (await h.get(`/api/eval-runs/${first}/results/s004`)).body.repeats[0];
    expect(violation.output.kind).toBe("conversation");
    expect(violation.tool_call_count).toBe(2);

    // Safety: the blocked tools never ran, no approval was recorded, and the operator views are what they were.
    expect(h.backend.executed.filter((t) => t === "write" || t === "bash")).toEqual([]);
    expect([...h.backend.executed].sort()).toEqual(["read", "read"]);
    const refs1 = await h.store.listEvalSubjectRefs(first, "agent");
    expect(refs1).toHaveLength(12);
    for (const ref of refs1) expect((h.service as any).store.listApprovals(ref)).toEqual([]);
    expect(await h.service.pendingApprovals(h.root, { includeEval: true })).toEqual(before.approvals);
    const after = await h.service.listAllSessions(h.root, { limit: 50 } as never);
    expect(after.sessions.length).toBe(before.sessions);
    expect(after.stats).toEqual(before.stats);
    expect(h.simulator.calls).toHaveLength(0);

    // The agent edit makes a new revision; run 1 keeps the revision it ran against and shows it is out of date.
    const rev1 = run1.config.target.revision as number;
    const agentFile = path.join(h.root, "agents", "support_sample.agent.yaml");
    await writeFile(agentFile, (await readFile(agentFile, "utf8")).replace("at most three sentences", "at most two sentences"));
    await h.service.list(h.root);
    state.stable = true;
    const second = await h.run("support-sample", { label: "after agent edit" });
    const run2 = (await h.get(`/api/eval-runs/${second}`)).body;
    expect(run2.config.target.revision).toBeGreaterThan(rev1);
    expect((await h.get(`/api/eval-runs/${first}`)).body.config.target.revision).toBe(rev1);
    expect((await h.get(`/api/eval-runs/${first}`)).body.current.agent_revision).toBe(run2.config.target.revision);

    // Run 2: s001 now states the limit both times: 8 / 12 passed, nothing flaky, 4 of 6 cases pass every repeat.
    expect(run2.stats).toMatchObject({
      results_executed: 12,
      results_passed: 8,
      pass_rate: 8 / 12,
      reliability: 4 / 6,
      pass_any: 4 / 6,
      flaky_cases: [],
    });
    expect(run2.stats.cost_stage).toBeCloseTo(0.14, 10);

    const cmp = (await h.get(`/api/eval-compare?a=${first}&b=${second}`)).body;
    expect(cmp.shared_cases).toBe(6);
    expect(cmp.same_config).toBe(false);
    expect(cmp.stage_diff).toBeNull();
    expect(cmp.agent_diff.changed_keys).toEqual(["instructions"]);
    expect(cmp.agent_diff.revision).toEqual({ a: rev1, b: run2.config.target.revision });
    expect(cmp.agent_diff.instructions_diff.some((l: any) => String(l.text).includes("at most two sentences"))).toBe(true);
    expect(cmp.cases.map((c: any) => [c.case_id, c.change])).toContainEqual(["s001", "improved"]);
    expect(cmp.verdict).toBe("no_clear_difference");

    // Review: tag the forbidden-tool failure of run 1.
    const tagged = await h.call("PUT", `/api/eval-runs/${first}/results/s004/0/review`, {
      label: "fail",
      note: "tried to write a file",
      tags: ["Forbidden tool"],
    });
    expect(tagged.status).toBe(200);
    const afterTag = (await h.get(`/api/eval-runs/${first}`)).body;
    expect(afterTag.stats.failure_types).toEqual({ by_tag: { "Forbidden tool": 1 }, untagged: 4 });

    // Delete run 1: its eval sessions go, run 2's stay.
    expect((await h.call("DELETE", `/api/eval-runs/${first}`)).status).toBe(204);
    for (const ref of refs1) await expect(h.service.getSession(h.root, ref)).rejects.toMatchObject({ code: "agent.session_not_found" });
    const refs2 = await h.store.listEvalSubjectRefs(second, "agent");
    expect(refs2).toHaveLength(12);
    await expect(h.service.getSession(h.root, refs2[0]!)).resolves.toBeDefined();
    expect((await h.get(`/api/eval-runs/${second}`)).status).toBe(200);
  }, 90_000);

  it("runs a simulated scenario with the fake simulator and counts the simulator's cost", async () => {
    const SIM = `version: 1
id: sim-basics
type: capability
target:
  kind: agent
  agent: support
dataset: ../datasets/sim.dataset.jsonl
defaults:
  repeats: 1
  pass_threshold: 0.5
  max_cost_usd: 2
  concurrency: 1
  user_model: anthropic/claude-sonnet-4-5
conversation:
  mode: simulated
  max_turns: 4
  tools: read_only
  approvals: record_only
graders:
  - id: short-chat
    type: conversation_check
    max_turns: 3
`;
    const dataset = [
      { id: "m1", input: { mode: "simulated", persona: "Polite customer", goal: "Learn where invoice INV-1 is", opening: "Where is INV-1?" } },
      { id: "m2", input: { mode: "simulated", persona: "Rushed customer", goal: "Learn where invoice INV-2 is", opening: "Where is INV-2?" } },
    ]
      .map((c) => JSON.stringify(c))
      .join("\n");
    const h = await agentEvalHarness({
      script: () => ({ text: "It is on its way." }),
      extraFiles: { "evals/sim-basics.eval.yaml": SIM, "datasets/sim.dataset.jsonl": `${dataset}\n` },
    });
    open.push(h);
    const id = await h.run("sim-basics");
    const run = (await h.get(`/api/eval-runs/${id}`)).body;
    // Each conversation: the opening and the simulator's closing "Thanks" (marked resolved) are two agent turns (2 x 0.01) and one simulator call (0.001): 0.021 x 2.
    expect(run.stats).toMatchObject({ results_executed: 2, results_passed: 2, pass_rate: 1, mean_turns: 2, mean_tool_calls: 0 });
    expect(run.stats.cost_stage).toBeCloseTo(0.042, 10);
    expect(h.simulator.calls).toHaveLength(2);
    expect(h.backend.calls).toBe(4);
    const result = (await h.get(`/api/eval-runs/${id}/results/m1`)).body.repeats[0];
    expect(result.output).toMatchObject({ kind: "conversation", stop_reason: "resolved" });
  }, 30_000);

  it("drives sf eval validate and sf eval run --json: exit 1 below threshold, exit 0 when passing", async () => {
    const h = await setup();
    const cli = await cliFor(h);

    const valid = await cli(["validate", "support-sample", "--json"]);
    expect(valid.code, valid.out.join("\n") + valid.err.join("\n")).toBe(0);
    expect(valid.doc()).toMatchObject({ ok: true, scope: "full" });

    // s001 (1 of 2) + s004 (0 of 2) = 1 / 4, below the 0.8 threshold.
    const below = await cli(["run", "support-sample", "--json", "--case", "s001", "--case", "s004"]);
    expect(below.code).toBe(1);
    expect(below.doc()).toMatchObject({
      outcome: "below_threshold",
      eval_id: "support-sample",
      target_kind: "agent",
      pass_rate: 0.25,
      threshold: 0.8,
      results: { executed: 4, passed: 1 },
    });

    // s002 + s006: 4 / 4. Mean turns 1, mean tool calls (0 + 0 + 1 + 1) / 4 = 0.5.
    const passed = await cli(["run", "support-sample", "--json", "--case", "s002", "--case", "s006"]);
    expect(passed.code).toBe(0);
    expect(passed.doc()).toMatchObject({
      outcome: "passed",
      pass_rate: 1,
      results: { executed: 4, passed: 4, errored: 0 },
      mean_turns: 1,
      mean_tool_calls: 0.5,
    });
  }, 60_000);

  it("refuses real tools without consent over HTTP and the CLI, and runs nothing", async () => {
    const REAL = realEvalYaml("real-ok", "  mode: script\n  tools: real\n  allow_real_tools: true\n  approvals: deny\n");
    const h = await agentEvalHarness({ extraFiles: { "evals/real-ok.eval.yaml": REAL } });
    open.push(h);
    const cli = await cliFor(h);

    const http = await h.post("/api/evals/real-ok/runs", { project_root: h.root });
    expect(http.status).toBe(422);
    expect(http.body.code).toBe("EVAL_REAL_TOOLS_NOT_CONFIRMED");
    const refused = await cli(["run", "real-ok"]);
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toMatch(/EVAL_REAL_TOOLS_NOT_CONFIRMED/);
    expect(refused.err.join("\n")).toMatch(/--allow-real-tools/);
    expect(await h.store.listEvalRuns({ evalId: "real-ok", limit: 5 })).toMatchObject({ items: [] });
    expect(h.backend.calls).toBe(0);
  }, 30_000);
});
