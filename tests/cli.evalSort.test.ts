import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVAL_USAGE, runEvalCommand } from "../src/cli/evalCommand.js";
import { alreadyUp } from "./helpers/testInProcessService.js";

type Call = { method: string; url: string; body: any };
type Reply = { status: number; body?: unknown };

let server: Server;
let baseUrl: string;
let calls: Call[];
let replies: Map<string, Reply>;
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
  replies = new Map();
  tmp = await mkdtemp(path.join(tmpdir(), "sf-eval-sort-cli-"));
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const call: Call = { method: req.method ?? "GET", url: req.url ?? "/", body: await readBody(req) };
    calls.push(call);
    const reply: Reply =
      call.url === "/api/projects"
        ? { status: 200, body: { project_root: call.body.project_root } }
        : (replies.get(`${call.method} ${call.url}`) ?? { status: 404, body: { error: "not found", code: "NOT_FOUND" } });
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

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runEvalCommand(args, {
    cwd: tmp,
    io: { log: (l) => stdout.push(l), error: (l) => stderr.push(l) },
    hostBaseUrl: baseUrl,
    ensureService: alreadyUp,
    stderrIsTTY: false,
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout.join("\n")) };
}

const suggestion = {
  id: "sg_1",
  case_id: "c1",
  repeat_index: 0,
  source: "jev",
  bucket: "grader_wrong",
  failure_type: "tone",
  confidence: 0.91,
  status: "pending",
};

const sortBody = { batch_id: "sb_1", classifier: "jev", model: "jev-1.13.0", sorted: 1, skipped: 2, failed: 0, triage_cost_usd: 0.042, suggestions: [suggestion] };

describe("sf eval sort and suggestions", () => {
  it("documents both subcommands", () => {
    expect(EVAL_USAGE).toContain("sf eval sort <evalRunId>");
    expect(EVAL_USAGE).toContain("sf eval suggestions <evalRunId>");
  });

  it("sorts with the defaults and prints a summary line and one line per suggestion", async () => {
    replies.set("POST /api/eval-runs/er_1/failures/sort", { status: 200, body: sortBody });
    const r = await run(["sort", "er_1"]);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.url.endsWith("/failures/sort"))?.body).toEqual({ classifier: "auto" });
    expect(r.stdout[0]).toContain("Sorted 1, skipped 2, failed 0 with jev (jev-1.13.0)");
    expect(r.stdout[0]).toContain("$0.04");
    expect(r.stdout[1]).toBe("c1\t#0\tgrader_wrong\ttone\t91%\tpending");
  });

  it("passes --classifier, --limit and --resort and prints the raw JSON with --json", async () => {
    replies.set("POST /api/eval-runs/er_1/failures/sort", { status: 200, body: sortBody });
    const r = await run(["sort", "er_1", "--classifier", "judge", "--limit", "5", "--resort", "--json"]);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.url.endsWith("/failures/sort"))?.body).toEqual({ classifier: "judge", only_unsorted: false, limit: 5 });
    expect(r.json()).toEqual(sortBody);
  });

  it("exits 1 with the code and what to add when no classifier is available", async () => {
    replies.set("POST /api/eval-runs/er_1/failures/sort", {
      status: 422,
      body: { error: "Add a TypeSafe key", code: "EVAL_CLASSIFIER_UNAVAILABLE", missing: "typesafe_key" },
    });
    const text = await run(["sort", "er_1"]);
    expect(text.code).toBe(1);
    expect(text.stderr.join("\n")).toContain("EVAL_CLASSIFIER_UNAVAILABLE: Add a TypeSafe key");
    const asJson = await run(["sort", "er_1", "--json"]);
    expect(asJson.code).toBe(1);
    expect(asJson.json()).toMatchObject({ code: "EVAL_CLASSIFIER_UNAVAILABLE", status: 422 });
  });

  it("lists suggestions with a status filter and the summary line", async () => {
    const summary = { by_bucket: { agent_wrong: 0, grader_wrong: 1, case_wrong: 0, unclear: 0 }, by_type: { tone: 1 }, pending: 1, accepted: 0, dismissed: 0, low_confidence: 0 };
    replies.set("GET /api/eval-runs/er_1/failures/suggestions?status=pending", { status: 200, body: { items: [suggestion], summary } });
    const r = await run(["suggestions", "er_1", "--status", "pending"]);
    expect(r.code).toBe(0);
    expect(r.stdout[0]).toBe("c1\t#0\tgrader_wrong\ttone\t91%\tpending");
    expect(r.stdout[1]).toContain("grader_wrong 1");
    expect(r.stdout[1]).toContain("pending 1");
    const asJson = await run(["suggestions", "er_1", "--status", "pending", "--json"]);
    expect(asJson.json()).toEqual({ items: [suggestion], summary });
  });

  it("rejects bad usage with exit 1", async () => {
    expect((await run(["sort"])).code).toBe(1);
    expect((await run(["sort", "er_1", "--classifier", "magic"])).code).toBe(1);
    expect((await run(["sort", "er_1", "--limit", "0"])).code).toBe(1);
    expect((await run(["suggestions", "er_1", "--status", "bogus"])).code).toBe(1);
    expect((await run(["suggestions", "er_1", "--resort"])).code).toBe(1);
  });
});
