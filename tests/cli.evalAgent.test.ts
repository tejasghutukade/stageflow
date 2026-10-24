import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_USAGE, runEvalCommand } from "../src/cli/evalCommand.js";
import { agentEvalHarness, realEvalYaml, type AgentEvalHarness } from "./helpers/agentEvalHarness.js";
import { alreadyUp } from "./helpers/testInProcessService.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REAL = realEvalYaml("real-ok", "  mode: script\n  tools: real\n  allow_real_tools: true\n  approvals: deny\n");

/** The real eval routes behind a one-route project endpoint, so the CLI talks to real handlers. */
async function setup(opts: Parameters<typeof agentEvalHarness>[0] = {}) {
  const h: AgentEvalHarness = await agentEvalHarness(opts);
  cleanups.push(() => h.close());
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
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
  const cli = async (args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runEvalCommand(args, {
      cwd: h.root,
      io: { log: (l) => stdout.push(l), error: (l) => stderr.push(l) },
      hostBaseUrl: baseUrl,
      ensureService: alreadyUp,
      pollIntervalMs: 5,
      stderrIsTTY: false,
    });
    return { code, stdout, stderr, json: () => JSON.parse(stdout.join("\n")) };
  };
  return { h, cli };
}

describe("sf eval with agent targets", () => {
  it("documents the new flags in the usage text", () => {
    expect(EVAL_USAGE).toContain("--user-model <model>");
    expect(EVAL_USAGE).toContain("--allow-real-tools");
    expect(EVAL_USAGE).not.toMatch(/eval new/);
  });

  it("prints agent targets in list and show, and the conversation settings", async () => {
    const { cli } = await setup();
    const list = await cli(["list"]);
    expect(list.code).toBe(0);
    const agentLine = list.stdout.find((l) => l.startsWith("script-basics"))!;
    expect(agentLine).toMatch(/Agent support r\d+/);
    expect(list.stdout.find((l) => l.startsWith("review"))).toContain("feature-ship");

    const show = await cli(["show", "script-basics"]);
    expect(show.code).toBe(0);
    expect(show.stdout[0]).toMatch(/^Agent support r\d+ \(anthropic\/claude-haiku-4-5\)$/);
    expect(show.stdout[1]).toBe("Conversation: script, up to 4 turns, tools read_only, approvals record_only");
    expect(show.stdout.join("\n")).toContain("kind: agent");

    const stage = await cli(["show", "review"]);
    expect(stage.stdout.join("\n").startsWith("version: 1")).toBe(true);
    expect(stage.stdout.join("\n")).not.toContain("Conversation:");
  });

  it("runs an agent eval to a passing result with the documented json document", async () => {
    const { cli } = await setup();
    const run = await cli(["run", "script-basics", "--json", "--repeats", "1"]);
    expect(run.code).toBe(0);
    const doc = run.json();
    expect(doc).toMatchObject({
      outcome: "passed",
      eval_id: "script-basics",
      target_kind: "agent",
      agent_id: "support",
      tools_policy: "read_only",
    });
    expect(typeof doc.agent_revision).toBe("number");
    expect(doc.mean_turns).toBeGreaterThan(0);
    expect(doc.mean_tool_calls).toBeGreaterThan(0);
    expect(Object.keys(doc)).toEqual(
      expect.arrayContaining(["outcome", "eval_run_id", "pass_rate", "threshold", "results", "cost_total", "fingerprint", "url"]),
    );

    const human = await cli(["run", "script-basics", "--repeats", "1"]);
    expect(human.code).toBe(0);
    expect(human.stdout.join("\n")).toMatch(/Agent support r\d+, tools read_only/);
    expect(human.stdout.join("\n")).toMatch(/Mean turns: [0-9.]+, mean tool calls: [0-9.]+/);

    const shown = await cli(["runs", "show", doc.eval_run_id]);
    expect(shown.stdout.join("\n")).toMatch(/Agent support r\d+/);
    expect(shown.stdout.join("\n")).toContain("Conversation: script, up to 4 turns, tools read_only");
    expect(shown.stdout.join("\n")).toMatch(/mean turns [0-9.]+/);
  });

  it("exits 1 with a clear message for real tools without --allow-real-tools, and warns with it", async () => {
    const { cli, h } = await setup({ extraFiles: { "evals/real-ok.eval.yaml": REAL } });
    const refused = await cli(["run", "real-ok"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr.join("\n")).toMatch(/EVAL_REAL_TOOLS_NOT_CONFIRMED/);
    expect(refused.stderr.join("\n")).toMatch(/--allow-real-tools/);
    expect(await h.store.listEvalRuns({ evalId: "real-ok", limit: 5 })).toMatchObject({ items: [] });

    const refusedJson = await cli(["run", "real-ok", "--json"]);
    expect(refusedJson.code).toBe(1);
    expect(refusedJson.json()).toEqual({
      ok: false,
      code: "EVAL_REAL_TOOLS_NOT_CONFIRMED",
      message: expect.stringContaining("real tools"),
    });

    const allowed = await cli(["run", "real-ok", "--allow-real-tools", "--json"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain("Warning: real tools can change files and call services from this machine.");
    expect(allowed.json()).toMatchObject({ target_kind: "agent", tools_policy: "real" });

    const harmless = await cli(["run", "script-basics", "--allow-real-tools", "--json"]);
    expect(harmless.code).toBe(0);
    expect(harmless.stderr).not.toContain("Warning: real tools can change files and call services from this machine.");
  });

  it("passes --user-model and --model overrides through", async () => {
    const { cli, h } = await setup();
    const run = await cli([
      "run",
      "support-basics",
      "--json",
      "--repeats",
      "1",
      "--user-model",
      "anthropic/claude-haiku-4-5",
      "--model",
      "anthropic/claude-sonnet-4-5",
    ]);
    const detail = (await h.get(`/api/eval-runs/${run.json().eval_run_id}`)).body;
    expect(detail.config.overrides).toMatchObject({
      user_model: "anthropic/claude-haiku-4-5",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(detail.config.target.model).toBe("anthropic/claude-sonnet-4-5");

    const stage = await cli(["run", "review", "--user-model", "a/b", "--json"]);
    expect(stage.code).toBe(1);
  });

  it("rejects flags that belong to no subcommand and has no eval new", async () => {
    const { cli } = await setup();
    expect((await cli(["new", "--agent", "support"])).code).toBe(1);
    expect((await cli(["list", "--allow-real-tools"])).code).toBe(1);
    expect((await cli(["run", "script-basics", "--tools", "mocked"])).code).toBe(1);
  });
});
