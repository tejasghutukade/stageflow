import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompletedOnlyStageHandle, type StagePort, type StageRunInput } from "../src/agent/port.js";
import { runEvalCommand } from "../src/cli/evalCommand.js";
import { saveHostMcpServer } from "../src/config/mcpHostCatalog.js";
import { OAUTH_FILE_KEY_ENV, useHostMcpGrantEnv } from "../src/config/mcpOAuth.js";
import { updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
import { hostLoginAttemptKey, readFrozenHostLoginServers, resetFrozenHostLoginServersForTests } from "../src/config/hostLoginMcp.js";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import { createStageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import { handleMcpHttpRequest } from "../src/mcp/server.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { setStageMcpUpstreamForTests, type StageMcpUpstream } from "../src/runtime/stageMcpHost.js";
import { listStageMcpTools } from "../src/runtime/stageMcpWorker.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const alreadyUp = async () => ({ ok: true as const, alreadyRunning: true as const });

const BEARER = "sf-eval-bearer-DO-NOT-LEAK";
const GRANT = "sf-eval-grant-DO-NOT-LEAK";
const GRANT_REFRESH = "sf-eval-refresh-DO-NOT-LEAK";

type Seen = {
  mcp: string[];
  worker: string[];
  stdio: boolean;
  bearer: boolean;
  frozen: string[];
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  setStageMcpUpstreamForTests(undefined);
  resetFrozenHostLoginServersForTests();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetGlobalStageflowHomeForTests();
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function record(seen: Seen[], input: StageRunInput): Promise<unknown> {
  const stageId = input.stageId ?? input.stage.id;
  const frozen = readFrozenHostLoginServers(
    hostLoginAttemptKey({ runId: input.runId, stageId, attempt: input.roots.attempt }),
  );
  const worker = input.resolvedMcpServers ?? {};
  seen.push({
    mcp: [...(input.stage.mcp ?? [])],
    worker: Object.keys(worker),
    stdio: typeof worker.local?.command === "string",
    bearer: typeof worker.paid?.url === "string" && worker.paid.headers?.Authorization !== undefined,
    frozen: frozen.map((server) => server.name),
  });
  return listStageMcpTools({
    runId: input.runId,
    stageId,
    attempt: input.roots.attempt,
    stage: input.stage,
  });
}

function recordingAgent(seen: Seen[], listed: string[]): StagePort {
  const finish = (input: StageRunInput) => {
    const pending = record(seen, input);
    return createCompletedOnlyStageHandle({
      stageId: input.stage.id,
      run: async () => {
        await pending;
        return {
          ok: true as const,
          envelope: { status: "success" as const, summary: "ok", artifacts: [], payload: { ok: true } },
        };
      },
    });
  };
  return {
    openStage: finish,
    async runStage(input) {
      const event = await finish(input).next();
      if (event.status !== "completed") return { ok: false as const, reason: "stage did not finish" };
      return event.result;
    },
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-eval-oauth-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-eval-oauth-home-"));
  const prevHome = process.env.STAGEFLOW_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevKey = process.env[OAUTH_FILE_KEY_ENV];
  bindStageflowHomeForTests(home);
  process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  process.env[OAUTH_FILE_KEY_ENV] = Buffer.alloc(32, 4).toString("base64");
  useHostMcpGrantEnv();
  const paid = saveHostMcpServer(
    "paid",
    { url: "https://paid.example/mcp", headers: { Authorization: `Bearer ${BEARER}` } },
    home,
  );
  saveHostMcpServer("local", { command: "node", args: ["-e", "process.exit(0)"] }, home);
  saveHostMcpServer("signed", { url: "https://signed.example/mcp" }, home);
  await updateMcpOAuthTokensForUrl("signed", "https://signed.example/mcp", {
    accessToken: GRANT,
    refreshToken: GRANT_REFRESH,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }, { credentialStore: "encrypted-file" });
  for (const dir of ["stages", "evals", "datasets"]) await mkdir(path.join(root, dir), { recursive: true });
  const secrets = paid.secretsStored.length > 0 ? `secrets: [${paid.secretsStored.join(", ")}]\n` : "";
  await writeFile(
    path.join(root, "stages", "inventory.yaml"),
    `id: inventory
system_prompt: List the boards.
model: anthropic/claude-haiku-4-5
mcp: [local, paid, signed]
${secrets}io:
  input:
    schema:
      type: object
      properties:
        note:
          type: string
      required: [note]
  output:
    schema:
      type: object
      properties:
        ok:
          type: boolean
      required: [ok]
`,
  );
  await writeFile(
    path.join(root, "datasets", "boards.dataset.jsonl"),
    `${JSON.stringify({ id: "c1", input: { note: "hi" } })}\n`,
  );
  await writeFile(
    path.join(root, "evals", "boards.eval.yaml"),
    `version: 1
id: boards
target:
  kind: stage
  file: ../stages/inventory.yaml
dataset: ../datasets/boards.dataset.jsonl
defaults:
  repeats: 1
  pass_threshold: 1
  max_cost_usd: 1
  concurrency: 1
graders:
  - id: ok
    type: field
    checks:
      - { path: "payload.ok", op: equals, value: true }
`,
  );
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines: []\n  tasks: []\n  evals:\n    - evals\n  datasets:\n    - datasets\n",
  );

  const seen: Seen[] = [];
  const listed: string[] = [];
  const upstream: StageMcpUpstream = {
    async list(server) {
      listed.push(server.name);
      return { ok: true, tools: [{ name: "ping" }] };
    },
    async call() {
      return { ok: true, text: "pong" };
    },
  };
  setStageMcpUpstreamForTests(upstream);
  const store = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  const pipeline = new RunManager({
    agent: recordingAgent(seen, listed),
    store,
    cwd: root,
    projectRoot: root,
  });
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: createStageCaseRunner({ manager: pipeline, store, pollIntervalMs: 20 }),
    engines: () => new FakeEngine(),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
    isKnownModel: async () => true,
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
    manager: pipeline as unknown as RunManager,
    evalRunManager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => engine,
    isKnownModel: async () => true,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/projects") {
      readBody(req).then((body) => json(res, 200, { project_root: (body as { project_root?: string }).project_root }));
      return;
    }
    const handle = req.url?.startsWith("/mcp")
      ? handleMcpHttpRequest(req, res, {
          manager: pipeline as unknown as RunManager,
          store,
          cwd: root,
          evalRunManager,
          evalEngineStatus: () => engine,
        }).then(() => true)
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
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevKey === undefined) delete process.env[OAUTH_FILE_KEY_ENV];
    else process.env[OAUTH_FILE_KEY_ENV] = prevKey;
  });
  return {
    root,
    base,
    seen,
    listed,
    store,
    reset() {
      seen.length = 0;
      listed.length = 0;
      resetFrozenHostLoginServersForTests();
    },
  };
}

function expectSkipped(seen: Seen[], listed: string[]): void {
  expect(seen).toHaveLength(1);
  expect(seen[0]?.mcp).not.toContain("signed");
  expect(seen[0]?.mcp).toEqual(expect.arrayContaining(["local", "paid"]));
  expect(seen[0]?.stdio).toBe(true);
  expect(seen[0]?.bearer).toBe(true);
  expect(seen[0]?.frozen).not.toContain("signed");
  expect(listed).toEqual([]);
  expect(JSON.stringify({ seen, listed })).not.toContain(BEARER);
  expect(JSON.stringify({ seen, listed })).not.toContain(GRANT);
}

function expectConfirmed(seen: Seen[], listed: string[]): void {
  expect(seen).toHaveLength(1);
  expect(seen[0]?.mcp).toEqual(expect.arrayContaining(["local", "paid", "signed"]));
  expect(seen[0]?.stdio).toBe(true);
  expect(seen[0]?.bearer).toBe(true);
  expect(seen[0]?.worker).not.toContain("signed");
  expect(seen[0]?.frozen).toEqual(["signed"]);
  expect(listed).toEqual(["signed"]);
  expect(JSON.stringify(listed)).not.toContain(BEARER);
  expect(JSON.stringify(listed)).not.toContain(GRANT);
}

describe("eval host-login confirm", () => {
  it("run_eval skips a signed-in server unless allow_host_login is set, and still attaches stdio and bearer", async () => {
    const world = await setup();
    const skipped = await mcpCall(world.base, "run_eval", {
      eval_id: "boards",
      project_root: world.root,
      wait: true,
    });
    expect(skipped.isError, JSON.stringify(skipped.payload)).toBe(false);
    expect(skipped.payload.status).toBe("completed");
    expect(skipped.payload.config.overrides.allow_host_login).toBeUndefined();
    expect(skipped.payload.config.overrides.allow_real_tools).toBeUndefined();
    expectSkipped(world.seen, world.listed);
    const skippedFingerprint = skipped.payload.fingerprint as string;

    world.reset();
    const confirmed = await mcpCall(world.base, "run_eval", {
      eval_id: "boards",
      project_root: world.root,
      wait: true,
      allow_host_login: true,
    });
    expect(confirmed.isError, JSON.stringify(confirmed.payload)).toBe(false);
    expect(confirmed.payload.status).toBe("completed");
    expect(confirmed.payload.config.overrides.allow_host_login).toBe(true);
    expect(confirmed.payload.config.overrides.allow_real_tools).toBeUndefined();
    expect(confirmed.payload.fingerprint).toBe(skippedFingerprint);
    expectConfirmed(world.seen, world.listed);
    expect(JSON.stringify(confirmed.payload)).not.toContain(BEARER);
    expect(JSON.stringify(confirmed.payload)).not.toContain(GRANT);
  });

  it("try_eval_case skips a signed-in server unless allow_host_login is set, and still attaches stdio and bearer", async () => {
    const world = await setup();
    const skipped = await mcpCall(world.base, "try_eval_case", {
      eval_id: "boards",
      case_id: "c1",
      project_root: world.root,
    });
    expect(skipped.isError, JSON.stringify(skipped.payload)).toBe(false);
    expect(skipped.payload.result.status).toBe("completed");
    expectSkipped(world.seen, world.listed);

    world.reset();
    const confirmed = await mcpCall(world.base, "try_eval_case", {
      eval_id: "boards",
      case_id: "c1",
      project_root: world.root,
      allow_host_login: true,
    });
    expect(confirmed.isError, JSON.stringify(confirmed.payload)).toBe(false);
    expect(confirmed.payload.result.status).toBe("completed");
    expectConfirmed(world.seen, world.listed);
    expect(JSON.stringify(confirmed.payload)).not.toContain(BEARER);
    expect(JSON.stringify(confirmed.payload)).not.toContain(GRANT);
  });

  it("sf eval skips a signed-in server unless --allow-host-login is set, and still attaches stdio and bearer", async () => {
    const world = await setup();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) };
    const skippedCode = await runEvalCommand(["run", "boards", "--json"], {
      cwd: world.root,
      io,
      hostBaseUrl: world.base,
      ensureService: alreadyUp,
      pollIntervalMs: 20,
      stderrIsTTY: false,
    });
    expect(skippedCode, stderr.join("\n")).toBe(0);
    const skipped = JSON.parse(stdout.join("\n")) as { eval_run_id: string; fingerprint: string };
    const skippedRun = await world.store.getEvalRun(skipped.eval_run_id);
    expect(skippedRun?.config).toMatchObject({ overrides: {} });
    expect((skippedRun?.config as { overrides?: { allow_host_login?: boolean } }).overrides?.allow_host_login).toBeUndefined();
    expectSkipped(world.seen, world.listed);

    world.reset();
    stdout.length = 0;
    stderr.length = 0;
    const confirmedCode = await runEvalCommand(["run", "boards", "--allow-host-login", "--json"], {
      cwd: world.root,
      io,
      hostBaseUrl: world.base,
      ensureService: alreadyUp,
      pollIntervalMs: 20,
      stderrIsTTY: false,
    });
    expect(confirmedCode, stderr.join("\n")).toBe(0);
    const confirmed = JSON.parse(stdout.join("\n")) as { eval_run_id: string; fingerprint: string };
    const confirmedRun = await world.store.getEvalRun(confirmed.eval_run_id);
    expect(confirmedRun?.config).toMatchObject({ overrides: { allow_host_login: true } });
    expect(confirmed.fingerprint).toBe(skipped.fingerprint);
    expectConfirmed(world.seen, world.listed);
    expect(JSON.stringify(confirmedRun?.config)).not.toContain(BEARER);
    expect(JSON.stringify(confirmedRun?.config)).not.toContain(GRANT);
  });

  it("does not tell the agent to complete an OAuth callback", async () => {
    const text = await readFile(
      path.join("skills/stageflow-agents/references/mcp-servers.md"),
      "utf8",
    );
    expect(text).not.toMatch(/oauth\/complete/);
    expect(text).not.toMatch(/input field of `complete`/);
    expect(text).toMatch(/paste the resulting address into the console dialog/);
  });
});
