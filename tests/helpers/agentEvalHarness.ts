import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentChatController } from "../../src/agents/chatTurn.js";
import { EvalGateRegistry } from "../../src/agents/evalGate.js";
import { AgentService } from "../../src/agents/service.js";
import { AgentStore } from "../../src/agents/store.js";
import { FakeEngine, type FakeEngineOptions } from "../../src/evals/engine/index.js";
import { EvalRunManager } from "../../src/evals/manager.js";
import { createAgentCaseRunner } from "../../src/evals/runner/agentCaseRunner.js";
import { createEvalCaseRunner } from "../../src/evals/runner/caseRunner.js";
import { FakeAgentBackend, type FakeTurnReply } from "../../src/evals/runner/FakeAgentBackend.js";
import { FakeSimulatorModel } from "../../src/evals/runner/simulatorModel.js";
import type { StageCaseRunner } from "../../src/evals/runner/stageCaseRunner.js";
import { createRunStoreWithConnection } from "../../src/runstore/createStore.js";
import type { RunManager } from "../../src/runtime/runManager.js";
import { handleMcpHttpRequest } from "../../src/mcp/server.js";
import { json } from "../../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../../src/server/evalRoutes.js";
import { FIXTURES_ROOT } from "./fixturePaths.js";
import { mcpCall } from "./mcpCall.js";
import { bindStageflowHomeForTests } from "./workspaceTestHarness.js";

const AGENT_PROJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/evals/agent/project");

export type Api = { status: number; body: any; text: string };

export const SCRIPT_EVAL = `version: 1
id: script-basics
type: capability
target:
  kind: agent
  agent: support
dataset: ../datasets/script-scenarios.dataset.jsonl
defaults:
  repeats: 2
  pass_threshold: 0.5
  max_cost_usd: 2
  concurrency: 1
conversation:
  mode: script
  max_turns: 4
  tools: read_only
  approvals: record_only
  read_only_tools: [billing.lookup_invoice]
graders:
  - id: looks-up-the-invoice
    type: tool_calls
    must_call: [billing.lookup_invoice]
    must_not_call: [billing.refund]
  - id: short-chat
    type: conversation_check
    max_turns: 5
`;

export const SCRIPT_DATASET = [
  { id: "t1", title: "Invoice question", input: { mode: "script", script: ["Where is my invoice INV-1?", "Thanks"] } },
  { id: "t2", title: "Another one", input: { mode: "script", script: ["Check INV-2 please"] } },
]
  .map((c) => JSON.stringify(c))
  .join("\n");

export function realEvalYaml(id: string, conversation: string): string {
  return SCRIPT_EVAL.replace("id: script-basics", `id: ${id}`).replace(
    /conversation:\n(?: {2}.*\n)+/,
    `conversation:\n${conversation}`,
  );
}

const STAGE_EVAL = `version: 1
id: review
type: capability
target:
  kind: stage
  pipeline: ../pipelines/feature-ship.pipeline.yaml
  stage: review
dataset: ../datasets/review.dataset.jsonl
task:
  goal: Review the change.
defaults:
  repeats: 1
  judge: anthropic/claude-sonnet-4-5
graders:
  - id: verdict-ok
    type: field
    checks:
      - { path: "payload.verdict", op: equals, value: ok }
`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type AgentEvalHarness = Awaited<ReturnType<typeof agentEvalHarness>>;

export const defaultAgentScript: FakeTurnReply = (_input, index) => ({
  text: `answer ${index + 1}`,
  tools:
    index % 2 === 0
      ? [
          { tool: "billing.lookup_invoice", input: { invoice_id: "INV-1" } },
          { tool: "billing.refund", input: { invoice_id: "INV-1" } },
        ]
      : [],
});

/** A real SQLite store, a real AgentService on it, FakeAgentBackend + FakeEngine, behind the eval routes and the MCP server. */
export async function agentEvalHarness(
  opts: {
    script?: FakeTurnReply | readonly FakeTurnReply[];
    engine?: FakeEngineOptions;
    extraFiles?: Record<string, string>;
    prices?: Map<string, { inputPerMillion: number; outputPerMillion: number }>;
  } = {},
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sf-agent-evals-")));
  const home = await mkdtemp(path.join(tmpdir(), "sf-agent-evals-home-"));
  bindStageflowHomeForTests(home);
  await cp(AGENT_PROJECT, root, { recursive: true });
  for (const dir of ["pipelines", "stages"]) await mkdir(path.join(root, dir), { recursive: true });
  await cp(
    path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"),
    path.join(root, "pipelines", "feature-ship.pipeline.yaml"),
  );
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n");
  await writeFile(path.join(root, "datasets", "review.dataset.jsonl"), `${JSON.stringify({ id: "c1", input: { diff: "d" } })}\n`);
  await writeFile(path.join(root, "evals", "review.eval.yaml"), STAGE_EVAL);
  await writeFile(path.join(root, "datasets", "script-scenarios.dataset.jsonl"), `${SCRIPT_DATASET}\n`);
  await writeFile(path.join(root, "evals", "script-basics.eval.yaml"), SCRIPT_EVAL);
  for (const [rel, text] of Object.entries(opts.extraFiles ?? {})) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }

  const { store, connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
  await store.ensureProject(root);
  const agentStore = new AgentStore(connection);
  const service = new AgentService({ store: agentStore });
  const backend = new FakeAgentBackend(opts.script ?? defaultAgentScript);
  const evalGates = new EvalGateRegistry();
  const chat = new AgentChatController({ service, backend, evalGates });
  const simulator = new FakeSimulatorModel(() => "Thanks, that is all.\n[[END:resolved]]");
  const agentRunner = createAgentCaseRunner({
    host: () => ({ service, chat, evalGates, backend }),
    simulatorModel: () => simulator,
  });
  const stageRunner: StageCaseRunner = {
    async runCase() {
      return { ok: false, code: "EVAL_STAGE_FAILED", message: "stage runs are not part of this harness" };
    },
    async cancelAll() {},
    spend: () => 0,
    addSpend: () => undefined,
  };
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: createEvalCaseRunner({ stage: stageRunner, agent: agentRunner }),
    agents: () => service,
    engines: () => new FakeEngine(opts.engine),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
  });
  const engine = {
    installed: true,
    version: "0.124.0",
    pinned: "0.124.0",
    node: "22.22.0",
    nodeOk: true,
    path: "/engine",
    installCommand: "sf eval engine install",
  };
  const apiDeps: EvalRoutesDeps = {
    cwd: root,
    store,
    manager: { deleteRun: async () => ({ ok: true }) } as unknown as RunManager,
    evalRunManager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => engine,
    isKnownModel: async () => true,
    agents: () => service,
    loadPrices: async () =>
      opts.prices ??
      new Map([
        ["anthropic/claude-haiku-4-5", { inputPerMillion: 1, outputPerMillion: 5 }],
        ["anthropic/claude-sonnet-4-5", { inputPerMillion: 3, outputPerMillion: 15 }],
      ]),
  };
  const mcpDeps = {
    manager: {} as unknown as RunManager,
    store,
    cwd: root,
    evalRunManager,
    evalEngineStatus: () => engine,
    agentService: service,
  };
  const server: Server = createServer((req, res) => {
    const handle = req.url?.startsWith("/mcp")
      ? handleMcpHttpRequest(req, res, mcpDeps).then(() => true)
      : handleEvalRoutes(req, res, apiDeps);
    handle.then(
      (handled) => {
        if (!handled) json(res, 404, { error: "Not found" });
      },
      () => json(res, 500, { error: "unhandled" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, urlPath: string, body?: unknown): Promise<Api> => {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed, text };
  };
  const harness = {
    base,
    root,
    home,
    store,
    service,
    backend,
    simulator,
    engine,
    manager: evalRunManager,
    call,
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
    q: `project_root=${encodeURIComponent(root)}`,
    tool: (name: string, args: Record<string, unknown> = {}) => mcpCall(base, name, args),
    /** Start a run, wait for it and return the eval run id. */
    async run(evalId: string, body: Record<string, unknown> = {}): Promise<string> {
      const res = await call("POST", `/api/evals/${evalId}/runs`, { project_root: root, ...body });
      if (res.status !== 202) throw new Error(`start failed ${res.status}: ${res.text}`);
      await evalRunManager.awaitFinished(res.body.eval_run_id, 15_000);
      return res.body.eval_run_id as string;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
  return harness;
}
