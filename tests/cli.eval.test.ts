import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVAL_USAGE, runEvalCommand } from "../src/cli/evalCommand.js";
import type { RunNpm } from "../src/evals/engine/promptfoo/install.js";
import { PINNED_PROMPTFOO_VERSION } from "../src/evals/engine/promptfoo/pinned.js";
import { alreadyUp } from "./helpers/testInProcessService.js";

type Call = { method: string; url: string; body: any };
type Reply = { status: number; body?: unknown };
type Handler = (call: Call) => Reply | undefined;

let server: Server;
let baseUrl: string;
let calls: Call[];
let handlers: Handler[];
let tmp: string;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text === "" ? undefined : JSON.parse(text));
    });
  });
}

beforeEach(async () => {
  calls = [];
  handlers = [];
  tmp = await mkdtemp(path.join(tmpdir(), "sf-eval-cli-"));
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const call: Call = { method: req.method ?? "GET", url: req.url ?? "/", body: await readBody(req) };
    calls.push(call);
    let reply: Reply | undefined;
    if (call.method === "POST" && call.url === "/api/projects") {
      reply = { status: 200, body: { project_root: call.body.project_root } };
    } else {
      for (const h of handlers) {
        reply = h(call);
        if (reply) break;
      }
    }
    reply ??= { status: 404, body: { error: "not found", code: "NOT_FOUND" } };
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cap() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { log: (l: string) => stdout.push(l), error: (l: string) => stderr.push(l) },
  };
}

async function run(args: string[], extra: Record<string, unknown> = {}) {
  const c = cap();
  const code = await runEvalCommand(args, {
    cwd: tmp,
    io: c.io,
    hostBaseUrl: baseUrl,
    ensureService: alreadyUp,
    pollIntervalMs: 5,
    stderrIsTTY: false,
    ...extra,
  });
  return { code, c, json: () => JSON.parse(c.stdout.join("\n")) };
}

function runDetail(overrides: Record<string, unknown> = {}) {
  return {
    eval_run_id: "er_1",
    run_number: 3,
    eval_id: "demo",
    status: "completed",
    status_reason: null,
    passed: true,
    progress: { results_done: 6, results_total: 6, cost_usd: 0.12, max_cost_usd: 5, cases_total: 3 },
    config: { settings: { pass_threshold: 0.8 } },
    fingerprint: "abcd1234",
    components: {},
    stats: {
      pass_rate: 0.9,
      pass_rate_ci: { low: 0.7, high: 0.97 },
      results_executed: 6,
      results_passed: 5,
      errored: 1,
      reliability: 0.8,
      cost_total: 0.12,
    },
    ...overrides,
  };
}

function startHandler(reply?: Reply): Handler {
  return (call) =>
    call.method === "POST" && call.url === "/api/evals/demo/runs"
      ? (reply ?? { status: 202, body: { eval_run_id: "er_1", status: "queued", run_number: 3 } })
      : undefined;
}

function getRunHandler(details: unknown[]): Handler {
  let i = 0;
  return (call) =>
    call.method === "GET" && call.url === "/api/eval-runs/er_1"
      ? { status: 200, body: details[Math.min(i++, details.length - 1)] }
      : undefined;
}

describe("sf eval run", () => {
  it("prints the documented document and exits 0 on a passed run", async () => {
    handlers.push(startHandler(), getRunHandler([runDetail({ status: "running", passed: null }), runDetail()]));
    const r = await run(["run", "demo", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      outcome: "passed",
      eval_run_id: "er_1",
      eval_id: "demo",
      pass_rate: 0.9,
      pass_rate_ci: { low: 0.7, high: 0.97 },
      threshold: 0.8,
      results: { executed: 6, passed: 5, errored: 1 },
      reliability: 0.8,
      cost_total: 0.12,
      fingerprint: "abcd1234",
      url: `${baseUrl}/#/evals/demo/runs/3`,
    });
    const start = calls.find((c) => c.url === "/api/evals/demo/runs")!;
    expect(start.body).toMatchObject({ started_via: "cli" });
  });

  it("prints below_threshold and exits 1", async () => {
    handlers.push(startHandler(), getRunHandler([runDetail({ passed: false })]));
    const r = await run(["run", "demo", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json().outcome).toBe("below_threshold");
  });

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["budget_stopped", "budget_stopped"],
  ])("exits 1 for a %s run", async (status, outcome) => {
    handlers.push(startHandler(), getRunHandler([runDetail({ status, passed: null, stats: null })]));
    const r = await run(["run", "demo", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({
      outcome,
      pass_rate: null,
      results: { executed: 0, passed: 0, errored: 0 },
      reliability: null,
    });
  });

  it("prints a validate-shaped document with no eval_run_id on EVAL_INVALID", async () => {
    handlers.push(
      startHandler({
        status: 422,
        body: {
          error: "invalid",
          code: "EVAL_INVALID",
          findings: [
            {
              severity: "error",
              code: "eval.bad",
              path: "evals/demo.eval.yaml",
              message: "bad grader",
              category: "eval",
            },
          ],
        },
      }),
    );
    const r = await run(["run", "demo", "--json"]);
    expect(r.code).toBe(1);
    const doc = r.json();
    expect(doc.ok).toBe(false);
    expect(doc.findings[0]).toMatchObject({ code: "eval.bad", file: "evals/demo.eval.yaml" });
    expect(doc.eval_run_id).toBeUndefined();
  });

  it("exits 1 on EVAL_ENGINE_UNAVAILABLE", async () => {
    handlers.push(
      startHandler({
        status: 503,
        body: { error: "The eval engine is not installed.", code: "EVAL_ENGINE_UNAVAILABLE" },
      }),
    );
    const r = await run(["run", "demo", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({
      error: "The eval engine is not installed.",
      code: "EVAL_ENGINE_UNAVAILABLE",
      status: 503,
    });
    const human = await run(["run", "demo"]);
    expect(human.code).toBe(1);
    expect(human.c.stderr.join("\n")).toContain("EVAL_ENGINE_UNAVAILABLE");
  });

  it("--no-wait prints the id and exits 0 without polling", async () => {
    handlers.push(startHandler());
    const human = await run(["run", "demo", "--no-wait"]);
    expect(human.code).toBe(0);
    expect(human.c.stdout).toEqual(["er_1"]);
    const json = await run(["run", "demo", "--no-wait", "--json"]);
    expect(json.code).toBe(0);
    expect(json.json()).toEqual({ eval_run_id: "er_1", status: "queued" });
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("sends repeated --case, --tag and parsed options", async () => {
    handlers.push(startHandler());
    await run([
      "run", "demo", "--no-wait", "--repeats", "2", "--judge", "j", "--model", "m",
      "--max-cost", "1.5", "--label", "nightly", "--case", "a", "--case", "b",
    ]);
    await run(["run", "demo", "--no-wait", "--tag", "x", "--tag", "y"]);
    const starts = calls.filter((c) => c.url === "/api/evals/demo/runs");
    expect(starts[0].body).toMatchObject({
      repeats: 2,
      judge: "j",
      model: "m",
      max_cost_usd: 1.5,
      label: "nightly",
      case_ids: ["a", "b"],
    });
    expect(starts[0].body.tags).toBeUndefined();
    expect(starts[1].body.tags).toEqual(["x", "y"]);
  });

  it("rejects bad --max-cost, --repeats, unknown flags and missing ids with usage and exit 1", async () => {
    for (const args of [
      ["run", "demo", "--max-cost", "abc"],
      ["run", "demo", "--max-cost", "-2"],
      ["run", "demo", "--repeats", "0"],
      ["run", "demo", "--bogus"],
      ["run"],
      ["run", "demo", "--case", "a", "--tag", "b"],
      ["nope"],
      [],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.c.stderr.join("\n")).toContain("Usage:");
    }
    expect(calls).toHaveLength(0);
  });

  it("cancels the eval run on Ctrl-C and exits 1", async () => {
    let interrupt: () => void = () => {};
    handlers.push(startHandler(), getRunHandler([runDetail({ status: "running", passed: null, stats: null })]), (call) =>
      call.method === "POST" && call.url === "/api/eval-runs/er_1/cancel"
        ? { status: 200, body: runDetail({ status: "cancelled", passed: null, stats: null }) }
        : undefined,
    );
    const pending = run(["run", "demo", "--json"], {
      onInterrupt: (handler: () => void) => {
        interrupt = handler;
        return () => {};
      },
    });
    for (let i = 0; i < 100 && !calls.some((c) => c.method === "GET"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    interrupt();
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.json().outcome).toBe("cancelled");
    expect(calls.some((c) => c.url === "/api/eval-runs/er_1/cancel")).toBe(true);
  });

  it("prints progress to stderr on a TTY and a human summary", async () => {
    handlers.push(
      startHandler(),
      getRunHandler([runDetail({ status: "running", passed: null, stats: null }), runDetail()]),
    );
    const r = await run(["run", "demo"], { stderrIsTTY: true });
    expect(r.code).toBe(0);
    expect(r.c.stderr.some((l) => l.includes("6/6 results"))).toBe(true);
    const out = r.c.stdout.join("\n");
    expect(out).toContain("PASSED");
    expect(out).toContain("abcd1234");
  });

  it("resolves a path to the eval id", async () => {
    await mkdir(path.join(tmp, "evals"), { recursive: true });
    await writeFile(path.join(tmp, "evals", "demo.eval.yaml"), "not: valid\n");
    handlers.push(startHandler());
    const r = await run(["run", "evals/demo.eval.yaml", "--no-wait"]);
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.url === "/api/evals/demo/runs")).toBe(true);
    const missing = await run(["run", "evals/missing.eval.yaml"]);
    expect(missing.code).toBe(1);
  });
});

describe("read subcommands", () => {
  it("list/show/runs/runs show/compare/datasets print the API objects", async () => {
    const list = { items: [{ id: "demo", status: "passing", valid: true }], banner: null, footer: {} };
    const detail = { id: "demo", yaml: "id: demo\n" };
    const runs = { items: [{ eval_run_id: "er_1", eval_id: "demo", run_number: 3 }], next_cursor: null };
    const compare = { a: "er_1", b: "er_2" };
    const datasets = { items: [{ id: "d", format: "jsonl", cases: 3, path: "datasets/d.dataset.jsonl" }] };
    handlers.push((call) => {
      if (call.url.startsWith("/api/evals?")) return { status: 200, body: list };
      if (call.url.startsWith("/api/evals/demo?")) return { status: 200, body: detail };
      if (call.url.startsWith("/api/eval-runs?")) return { status: 200, body: runs };
      if (call.url === "/api/eval-runs/er_1") return { status: 200, body: runDetail() };
      if (call.url === "/api/eval-compare?a=er_1&b=er_2") return { status: 200, body: compare };
      if (call.url.startsWith("/api/datasets?")) return { status: 200, body: datasets };
      return undefined;
    });
    expect((await run(["list", "--json"])).json()).toEqual(list);
    expect((await run(["show", "demo", "--json"])).json()).toEqual(detail);
    expect((await run(["runs", "demo", "--json"])).json()).toEqual(runs);
    expect(calls.some((c) => c.url.includes("eval_id=demo"))).toBe(true);
    expect((await run(["runs", "show", "er_1", "--json"])).json()).toEqual(runDetail());
    expect((await run(["compare", "er_1", "er_2", "--json"])).json()).toEqual(compare);
    expect((await run(["datasets", "--json"])).json()).toEqual(datasets);

    expect((await run(["list"])).c.stdout[0]).toContain("demo\tpassing\tvalid");
    expect((await run(["show", "demo"])).c.stdout.join("\n")).toContain("id: demo");
    expect((await run(["datasets"])).c.stdout[0]).toBe("d\tjsonl\t3\tdatasets/d.dataset.jsonl");
  });

  it("reports API errors as JSON and exits 1", async () => {
    handlers.push(() => ({ status: 404, body: { error: "Eval not found: x", code: "EVAL_NOT_FOUND" } }));
    const r = await run(["show", "x", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ error: "Eval not found: x", code: "EVAL_NOT_FOUND", status: 404 });
  });

  it("cancel and delete call the API", async () => {
    handlers.push(
      (call) =>
        call.method === "POST" && call.url === "/api/eval-runs/er_1/cancel"
          ? { status: 200, body: runDetail({ status: "cancelled" }) }
          : undefined,
      (call) => (call.method === "DELETE" && call.url === "/api/eval-runs/er_1" ? { status: 204 } : undefined),
    );
    expect((await run(["runs", "cancel", "er_1"])).code).toBe(0);
    expect((await run(["runs", "delete", "er_1"])).code).toBe(0);
    handlers.unshift(() => ({ status: 409, body: { error: "running", code: "EVAL_RUN_ACTIVE" } }));
    expect((await run(["runs", "delete", "er_1"])).code).toBe(1);
  });

  it("missing arguments print usage and exit 1", async () => {
    for (const args of [["show"], ["compare", "a"], ["runs", "show"], ["list", "extra"], ["engine"], ["engine", "nope"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.c.stderr.join("\n")).toContain(EVAL_USAGE);
    }
  });
});

describe("sf eval validate", () => {
  async function seed(): Promise<void> {
    await mkdir(path.join(tmp, "evals"), { recursive: true });
    await writeFile(path.join(tmp, "stageflow.yaml"), "version: 1\ncatalog:\n  evals:\n    - evals\n");
    await writeFile(path.join(tmp, "evals", "broken.eval.yaml"), "id: broken\nversion: 1\n");
  }

  it("works offline with the sf validate JSON shape and exits 1 on errors", async () => {
    await seed();
    const c = cap();
    const code = await runEvalCommand(["validate", "broken", "--json"], {
      cwd: tmp,
      io: c.io,
      hostBaseUrl: "http://127.0.0.1:1",
      ensureService: async () => {
        throw new Error("must not contact the Host");
      },
    });
    expect(code).toBe(1);
    const doc = JSON.parse(c.stdout.join("\n"));
    expect(doc).toMatchObject({ ok: false, scope: "full" });
    expect(doc.findings.length).toBeGreaterThan(0);
    expect(doc.findings[0]).toHaveProperty("file");
  });

  it("exits 1 for an unknown eval", async () => {
    await seed();
    const r = await run(["validate", "ghost"]);
    expect(r.code).toBe(1);
    expect(r.c.stderr.join("\n")).toContain("Eval not found: ghost");
  });
});

describe("sf eval engine", () => {
  it("status --json prints the documented shape", async () => {
    const r = await run(["engine", "status", "--json"], { home: tmp });
    expect(r.code).toBe(0);
    const doc = r.json();
    expect(Object.keys(doc).sort()).toEqual(
      ["install_command", "installed", "node", "node_ok", "pinned", "version"].sort(),
    );
    expect(doc).toMatchObject({ installed: false, version: null, pinned: PINNED_PROMPTFOO_VERSION });
    expect(calls).toHaveLength(0);
  });

  it("install runs the story 10 installer with a fake npm", async () => {
    const npmCalls: string[][] = [];
    const runNpm: RunNpm = async (args, { cwd }) => {
      npmCalls.push(args);
      const dir = path.join(cwd, "node_modules", "promptfoo");
      await mkdir(path.join(cwd, "node_modules", ".bin"), { recursive: true });
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "promptfoo", version: PINNED_PROMPTFOO_VERSION }),
      );
      await writeFile(path.join(cwd, "node_modules", ".bin", "promptfoo"), "#!/bin/sh\n");
      return { code: 0 };
    };
    const r = await run(["engine", "install"], { home: tmp, runNpm });
    expect(npmCalls).toHaveLength(1);
    expect(npmCalls[0]).toContain(`promptfoo@${PINNED_PROMPTFOO_VERSION}`);
    expect(r.code).toBe(0);
    expect(r.c.stdout[0]).toContain(PINNED_PROMPTFOO_VERSION);
  });

  it("install failure exits 1", async () => {
    const r = await run(["engine", "install"], { home: tmp, runNpm: async () => ({ code: 1 }) });
    expect(r.code).toBe(1);
  });
});
