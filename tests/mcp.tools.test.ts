import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { projectRunDetail } from "../src/runstore/runProjection.js";
import { startUiServer } from "../src/server/http.js";
import { projectRunForMcp } from "../src/mcp/projectRun.js";
import { readRunArtifact } from "../src/mcp/readArtifact.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let catalogRoot: string;
let cleanupCatalogRoot: () => Promise<void>;

beforeAll(async () => {
  const setup = await initTempGitRepo();
  catalogRoot = setup.root;
  cleanupCatalogRoot = setup.cleanup;
  await cp(path.join(fixtures, "pipelines"), path.join(catalogRoot, "pipelines"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "tasks"), path.join(catalogRoot, "tasks"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "stages"), path.join(catalogRoot, "stages"), {
    recursive: true,
  });
  await writeFile(
    path.join(catalogRoot, "stageflow.yaml"),
    [
      "version: 1",
      "catalog:",
      "  pipelines:",
      "    - pipelines",
      "  tasks:",
      "    - tasks",
      "  patterns:",
      '    pipeline: "*.yaml"',
      '    task: "*.yaml"',
      "",
    ].join("\n"),
  );
  clearFindProjectRootCacheForTests();
});

afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanupCatalogRoot();
});

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

async function mcpCall(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; meta?: Record<string, unknown> } = {},
) {
  const params: Record<string, unknown> = { name, arguments: args };
  if (opts.meta !== undefined) {
    params._meta = opts.meta;
  }
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    }),
    signal: opts.signal,
  });
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP response: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: unknown;
  };
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    status: res.status,
    isError: Boolean(message.result?.isError),
    payload: contentText ? JSON.parse(contentText) : null,
    raw: message,
  };
}

async function mcpListTools(base: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  const text = await res.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP tools/list: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };
  return message.result?.tools ?? [];
}

async function waitUntilIdleHealth(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const h = await mcpCall(base, "get_health");
    if (h.payload?.activeCount === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for idle health");
}

describe("MCP tools and HTTP inline task", () => {
  it("serves MCP tools and starts an inline task run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-"));
    const store = createRunStore({ rootDir: root });
    const { root: repoRoot, cleanup } = await initTempGitRepo();
    await cp(path.join(fixtures, "pipelines"), path.join(repoRoot, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(repoRoot, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(repoRoot, "stages"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "stageflow.yaml"),
      [
        "version: 1",
        "catalog:",
        "  pipelines:",
        "    - pipelines",
        "  tasks:",
        "    - tasks",
        "  patterns:",
        '    pipeline: "*.yaml"',
        '    task: "*.yaml"',
        "",
      ].join("\n"),
    );
    clearFindProjectRootCacheForTests();
    const agent = scriptedFakeAgent(
      Array.from({ length: 12 }, (_, i) => ({
        type: "emit" as const,
        envelope: {
          status: "success" as const,
          summary: `s${i}`,
          artifacts: [],
          payload: { n: i },
        },
      })),
    );

    const { server, mcpUrl } = await startUiServer({
      agent,
      cwd: repoRoot,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      expect(mcpUrl).toBe(`${base}/mcp`);

      const pipelines = await mcpCall(base, "list_pipelines");
      expect(pipelines.status).toBe(200);
      expect(pipelines.isError).toBe(false);
      expect(
        pipelines.payload.pipelines.some(
          (p: { path: string }) => p.path === "pipelines/docs-only.pipeline.yaml",
        ),
      ).toBe(true);

      const tasks = await mcpCall(base, "list_tasks");
      expect(tasks.isError).toBe(false);
      expect(tasks.payload.tasks).toEqual(expect.any(Array));

      const health = await mcpCall(base, "get_health");
      expect(health.payload).toEqual({
        ok: true,
        activeRunIds: [],
        activeCount: 0,
        maxConcurrent: expect.any(Number),
        slotsAvailable: expect.any(Number),
        activeStageProcesses: 0,
        maxActiveStageProcesses: null,
      });
      expect(health.payload).not.toHaveProperty("inFlight");
      expect(health.payload.slotsAvailable).toBe(health.payload.maxConcurrent);

      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("docs-only"),
        task: { id: "mcp-inline", goal: "from mcp" },
      });
      expect(started.isError).toBe(false);
      expect(started.payload.runId).toBeTruthy();
      const runId = started.payload.runId as string;

      await waitUntilIdleHealth(base);

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.run_id).toBe(runId);
      expect(detail.payload.stages[0].events).toBeUndefined();
      expect(detail.payload.task_yaml).toBeUndefined();
      expect(detail.payload.stages[0].envelope.summary).toBeTruthy();

      const restInline = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: pipelinePath("docs-only"),
          task: { id: "rest-inline", goal: "from rest" },
        }),
      });
      expect(restInline.status).toBe(202);
      expect(restInline.body.runId).toBeTruthy();

      for (let i = 0; i < 80; i++) {
        const h = await jsonFetch(`${base}/api/health`);
        if (h.body.activeCount === 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const forbidden = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/list",
          params: {},
        }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      clearFindProjectRootCacheForTests();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await cleanup();
    }
  });

  it("get_health / start_run expose soft-max capacity (AE5; not exclusive inFlight)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cap-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-mcp-co-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [
          {
            kind: "free_text",
            id: "prompt-1",
            message: "hold",
          },
        ],
        envelope: {
          status: "success",
          summary: "hold",
          artifacts: [],
        },
      },
      {
        type: "wait_then_emit",
        waitRequests: [
          {
            kind: "free_text",
            id: "prompt-1",
            message: "hold2",
          },
        ],
        envelope: {
          status: "success",
          summary: "hold2",
          artifacts: [],
        },
      },
    ]);

    const { server } = await startUiServer({
      agent,
      cwd: catalogRoot,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      maxConcurrent: 1,
      mcpStateless: true,
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const base = `http://127.0.0.1:${address.port}`;

      const tools = await mcpListTools(base);
      const getHealth = tools.find((t) => t.name === "get_health");
      const startRun = tools.find((t) => t.name === "start_run");
      expect(getHealth?.description ?? "").not.toMatch(/inFlight/i);
      expect(getHealth?.description ?? "").not.toMatch(/exclusive/i);
      expect(getHealth?.description ?? "").toMatch(/soft max|capacity|active/i);
      expect(startRun?.description ?? "").not.toMatch(/inFlight/i);
      expect(startRun?.description ?? "").toMatch(/busy_capacity|busy_checkout|checkout/i);

      const first = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "holder", goal: "hold", checkout },
      });
      expect(first.isError).toBe(false);
      const holderId = first.payload.runId as string;

      for (let i = 0; i < 80; i++) {
        const h = await mcpCall(base, "get_health");
        if (h.payload.activeRunIds?.includes(holderId)) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const health = await mcpCall(base, "get_health");
      expect(health.payload).toMatchObject({
        ok: true,
        activeCount: 1,
        maxConcurrent: 1,
        slotsAvailable: 0,
      });
      expect(health.payload.activeRunIds).toEqual([holderId]);
      expect(health.payload).not.toHaveProperty("inFlight");

      const overCap = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "over", goal: "no slot" },
      });
      expect(overCap.isError).toBe(true);
      expect(overCap.payload.code).toBe("busy_capacity");
      expect(overCap.payload.status).toBe(409);
      expect(overCap.payload.activeCount).toBe(1);
      expect(overCap.payload.maxConcurrent).toBe(1);
      expect(overCap.payload.activeRunIds).toEqual([holderId]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("start_run busy_checkout is distinct from busy_capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-co-busy-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-mcp-co-path-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [
          {
            kind: "free_text",
            id: "prompt-1",
            message: "hold",
          },
        ],
        envelope: {
          status: "success",
          summary: "hold",
          artifacts: [],
        },
      },
    ]);

    const { server } = await startUiServer({
      agent,
      cwd: catalogRoot,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      maxConcurrent: 3,
      mcpStateless: true,
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const base = `http://127.0.0.1:${address.port}`;

      const first = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "a", goal: "first", checkout },
      });
      expect(first.isError).toBe(false);
      const conflictId = first.payload.runId as string;

      for (let i = 0; i < 80; i++) {
        const h = await mcpCall(base, "get_health");
        if (h.payload.activeRunIds?.includes(conflictId)) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const conflict = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "b", goal: "same", checkout },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.payload.code).toBe("busy_checkout");
      expect(conflict.payload.conflictingRunId).toBe(conflictId);
      expect(conflict.payload.conflictingCheckout).toBeTruthy();
      expect(conflict.payload.activeRunIds).toEqual([conflictId]);
      expect(conflict.payload.code).not.toBe("busy_capacity");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("read_artifact stays inside the run workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-art-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join("stages", "clarify", "attempts", "1", "artifacts", "note.txt");
    await mkdir(path.join(created.workspaceDir, "stages", "clarify", "attempts", "1", "artifacts"), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), "hello artifact", "utf8");

    const content = await readRunArtifact(store, created.runId, rel);
    expect(content).toBe("hello artifact");

    await expect(
      readRunArtifact(store, created.runId, "../outside.txt"),
    ).rejects.toThrow(/^\.\.|must not contain/);

    await expect(
      readRunArtifact(store, created.runId, "/etc/passwd"),
    ).rejects.toThrow(/relative/);

    await expect(
      readRunArtifact(store, "../escape", rel),
    ).rejects.toThrow(/path separators|\.\./);
  });

  it("projectRunForMcp drops events and task_yaml but keeps pipeline_track", () => {
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "docs-only",
        created_at: "t",
        status: "succeeded",
      },
      [
        {
          stage_id: "clarify",
          status: "succeeded",
          events: [{ event: "started" }],
          envelope: {
            status: "success",
            summary: "ok",
            artifacts: ["stages/clarify/attempts/1/artifacts/a.txt"],
            payload: { k: 1 },
          },
          artifacts: ["stages/clarify/attempts/1/artifacts/a.txt"],
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRunForMcp(detail);
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
    expect(projected.pipeline_track.nodes).toHaveLength(1);
    expect(projected.pipeline_track.nodes[0]?.stage_id).toBe("clarify");
    expect(projected.stages[0]?.envelope?.payload).toEqual({ k: 1 });
  });

  it("projectRunForMcp mirrors waiting_stage_ids and pipeline_track", () => {
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "parallel-hitl-multi-wait",
        created_at: "t",
        status: "running",
      },
      [
        {
          stage_id: "clarify",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
        {
          stage_id: "branch-a",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
          pending_prompt: {
            kind: "free_text",
            id: "a",
            message: "A?",
          },
        },
        {
          stage_id: "branch-b",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
          pending_prompt: {
            kind: "free_text",
            id: "b",
            message: "B?",
          },
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRunForMcp(detail);
    expect(projected.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
    expect(projected.pipeline_track.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("projectRunForMcp mirrors pending_prompt when present", () => {
    const pending_prompt = {
      kind: "free_text" as const,
      id: "p1",
      message: "Name?",
    };
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "docs-only",
        created_at: "t",
        status: "running",
      },
      [
        {
          stage_id: "clarify",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
          pending_prompt,
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRunForMcp(detail);
    expect(projected.stages[0]?.pending_prompt).toEqual(pending_prompt);
  });
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

async function withMcpServer(
  root: string,
  agent: ReturnType<typeof scriptedFakeAgent> | Parameters<typeof startUiServer>[0]["agent"],
  store = createRunStore({ rootDir: root }),
  opts: { maxConcurrent?: number; cwd?: string; mcpStateless?: boolean } = {},
) {
  const started = await startUiServer({
    agent,
    cwd: opts.cwd ?? catalogRoot,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    maxConcurrent: opts.maxConcurrent,
    mcpStateless: opts.mcpStateless ?? true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    ...started,
    store,
    base: `http://127.0.0.1:${address.port}`,
  };
}

describe("MCP Tier 1 operator parity", () => {
  const freeTextPrompt = {
    kind: "free_text" as const,
    id: "prompt-1",
    message: "What should the module name be?",
  };
  const freeTextAnswer = {
    promptId: "prompt-1",
    kind: "free_text" as const,
    text: "payments",
  };

  it("list_waiting empty then includes waiting stage; answer_gate free_text succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-hitl-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const empty = await mcpCall(base, "list_waiting");
      expect(empty.isError).toBe(false);
      expect(empty.payload.waiting).toEqual([]);

      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const listed = await mcpCall(base, "list_waiting");
      expect(listed.isError).toBe(false);
      expect(listed.payload.waiting).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            stageId: "clarify",
            waiting_kind: "free_text",
            waiting_prompt_id: "prompt-1",
            pending_prompt: freeTextPrompt,
          }),
        ]),
      );

      const answered = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(answered.isError).toBe(false);
      expect(answered.payload).toEqual({ ok: true });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("answer_gate confirm / artifact_backed / multi_question succeed", async () => {
    const cases = [
      {
        label: "confirm",
        prompt: {
          kind: "confirm" as const,
          id: "confirm-proceed",
          message: "Proceed?",
        },
        answer: {
          promptId: "confirm-proceed",
          kind: "confirm" as const,
          decision: "accept" as const,
        },
      },
      {
        label: "artifact_backed",
        prompt: {
          kind: "artifact_backed" as const,
          id: "art-1",
          message: "Review artifact",
          artifacts: ["stages/clarify/attempts/1/artifacts/plan.md"],
        },
        answer: {
          promptId: "art-1",
          kind: "artifact_backed" as const,
          decision: "accept" as const,
        },
      },
      {
        label: "multi_question",
        prompt: {
          kind: "multi_question" as const,
          id: "mq-1",
          questions: [
            {
              id: "q-module",
              kind: "free_text" as const,
              message: "Module?",
            },
            {
              id: "q-owner",
              kind: "free_text" as const,
              message: "Owner?",
            },
          ],
        },
        answer: {
          promptId: "mq-1",
          kind: "multi_question" as const,
          answers: {
            "q-module": { kind: "free_text" as const, text: "payments" },
            "q-owner": { kind: "free_text" as const, text: "platform" },
          },
        },
      },
    ];

    for (const c of cases) {
      const root = await mkdtemp(path.join(tmpdir(), `sf-mcp-${c.label}-`));
      const agent = scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [c.prompt],
          envelope: {
            status: "success",
            summary: `${c.label}-ok`,
            artifacts: [],
          },
        },
      ]);
      const { server, base, store } = await withMcpServer(root, agent);
      try {
        const started = await mcpCall(base, "start_run", {
          pipeline: pipelinePath("single"),
          task: { id: "t", goal: "g" },
        });
        const runId = started.payload.runId as string;
        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.stages.some((s) => s.status === "waiting_for_input");
        });
        const answered = await mcpCall(base, "answer_gate", {
          runId,
          stageId: "clarify",
          answer: c.answer,
        });
        expect(answered.isError).toBe(false);
        expect(answered.payload).toEqual({ ok: true });
        await waitFor(async () => (await store.readRun(runId)).status === "succeeded");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  it("answer_gate malformed → 400; not waiting → 409; unknown → 404", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-ans-err-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const bad = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: { promptId: "prompt-1", kind: "confirm", decision: "accept" },
      });
      expect(bad.isError).toBe(true);
      expect(bad.payload.status).toBe(400);

      const missingRun = await mcpCall(base, "answer_gate", {
        runId: "does-not-exist",
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(missingRun.isError).toBe(true);
      expect(missingRun.payload.status).toBe(404);

      const missingStage = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "no-such-stage",
        answer: freeTextAnswer,
      });
      expect(missingStage.isError).toBe(true);
      expect(missingStage.payload.status).toBe(404);

      const ok = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(ok.isError).toBe(false);
      await waitFor(async () => (await store.readRun(runId)).status === "succeeded");

      const notWaiting = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(notWaiting.isError).toBe(true);
      expect(notWaiting.payload.status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("list_stage_events and get_envelope; get_run stays event-free", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-inspect-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: [],
          payload: { n: 1 },
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      await waitUntilIdleHealth(base);

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.stages[0].events).toBeUndefined();

      const events = await mcpCall(base, "list_stage_events", {
        runId,
        stageId: "clarify",
      });
      expect(events.isError).toBe(false);
      expect(events.payload.events.length).toBeGreaterThan(0);
      expect(events.payload.events.some((e: { event: string }) => e.event === "succeeded")).toBe(
        true,
      );

      const envelope = await mcpCall(base, "get_envelope", {
        runId,
        stageId: "clarify",
      });
      expect(envelope.isError).toBe(false);
      expect(envelope.payload.envelope.summary).toBe("clarify-ok");
      expect(envelope.payload.envelope.payload).toEqual({ n: 1 });

      const missingRun = await mcpCall(base, "list_stage_events", {
        runId: "missing",
        stageId: "clarify",
      });
      expect(missingRun.isError).toBe(true);
      expect(missingRun.payload.status).toBe(404);

      const missingStage = await mcpCall(base, "get_envelope", {
        runId,
        stageId: "nope",
      });
      expect(missingStage.isError).toBe(true);
      expect(missingStage.payload.status).toBe(404);

      void store;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("retry_stage / abandon_stage / rerun control tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-control-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "failure", summary: "design-fail", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "design-ok-retry", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "plan-ok", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "clarify-rerun", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "design-rerun", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "plan-rerun", artifacts: [] },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("linear-explicit"),
        task_path: "tasks/sample.task.yaml",
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => (await store.readRunMeta(runId)).status === "failed");

      const missingRetry = await mcpCall(base, "retry_stage", {
        runId: "missing",
        stageId: "design-doc",
      });
      expect(missingRetry.isError).toBe(true);
      expect(missingRetry.payload.status).toBe(404);

      const retried = await mcpCall(base, "retry_stage", {
        runId,
        stageId: "design-doc",
      });
      expect(retried.isError).toBe(false);
      expect(retried.payload).toEqual({
        runId,
        stageId: "design-doc",
        attemptIndex: 2,
      });

      await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");

      const rerun = await mcpCall(base, "rerun", { runId });
      expect(rerun.isError).toBe(false);
      expect(rerun.payload.runId).toBeTruthy();
      expect(rerun.payload.runId).not.toBe(runId);
      await waitUntilIdleHealth(base);

      const abandonRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-abandon-"));
      const abandonStore = createRunStore({ rootDir: abandonRoot });
      const abandonServer = await withMcpServer(
        abandonRoot,
        scriptedFakeAgent([]),
        abandonStore,
      );
      try {
        const planted = await abandonStore.createRun({
          pipelineId: "docs-only",
          taskYaml: "id: t\ngoal: g\n",
        });
        await abandonStore.appendStageEvent(planted.runId, "build", {
          event: "started",
        });
        await abandonStore.updateRunStatus(planted.runId, "running");

        const abandoned = await mcpCall(abandonServer.base, "abandon_stage", {
          runId: planted.runId,
          stageId: "build",
        });
        expect(abandoned.isError).toBe(false);
        expect(abandoned.payload).toEqual({
          ok: true,
          runId: planted.runId,
          stageId: "build",
        });

        const waitingPlant = await abandonStore.createRun({
          pipelineId: "docs-only",
          taskYaml: "id: t\ngoal: g\n",
        });
        await abandonStore.appendStageEvent(waitingPlant.runId, "clarify", {
          event: "started",
        });
        await abandonStore.appendStageEvent(waitingPlant.runId, "clarify", {
          event: "waiting_for_input",
        });
        const abandonWaiting = await mcpCall(abandonServer.base, "abandon_stage", {
          runId: waitingPlant.runId,
          stageId: "clarify",
        });
        expect(abandonWaiting.isError).toBe(true);
        expect(abandonWaiting.payload.status).toBe(409);

        const missingAbandon = await mcpCall(abandonServer.base, "abandon_stage", {
          runId: "missing",
          stageId: "build",
        });
        expect(missingAbandon.isError).toBe(true);
        expect(missingAbandon.payload.status).toBe(404);
      } finally {
        await new Promise<void>((resolve, reject) => {
          abandonServer.server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("retry_stage while waiting returns 409", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-retry-wait-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);
    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });
      const retried = await mcpCall(base, "retry_stage", {
        runId,
        stageId: "clarify",
      });
      expect(retried.isError).toBe(true);
      expect(retried.payload.status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("validate and describe_pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-validate-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));

    try {
      const full = await mcpCall(base, "validate", {});
      expect(full.isError).toBe(false);
      expect(full.payload).toMatchObject({
        ok: expect.any(Boolean),
        summary: expect.objectContaining({
          errors: expect.any(Number),
          warnings: expect.any(Number),
        }),
        findings: expect.any(Array),
      });

      const scoped = await mcpCall(base, "validate", {
        pipeline: pipelinePath("broken"),
      });
      expect(scoped.isError).toBe(false);
      expect(scoped.payload.ok).toBe(false);
      expect(scoped.payload.findings.length).toBeGreaterThan(0);

      const described = await mcpCall(base, "describe_pipeline", {
        pipeline: pipelinePath("clone-fanout-mix"),
      });
      expect(described.isError).toBe(false);
      expect(described.payload.id).toBe("clone-fanout-mix");
      expect(described.payload.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "clarify",
            fork: expect.objectContaining({ select: "subset" }),
          }),
          expect.objectContaining({
            id: "design-doc",
            clonable: true,
            clone_cap: 5,
            needs: "clarify",
          }),
        ]),
      );

      const missing = await mcpCall(base, "describe_pipeline", {
        pipeline: "pipelines/does-not-exist.pipeline.yaml",
      });
      expect(missing.isError).toBe(true);
      expect(missing.payload.error).toBeTruthy();

      for (const blank of ["", "   "]) {
        const emptyDescribe = await mcpCall(base, "describe_pipeline", {
          pipeline: blank,
        });
        expect(emptyDescribe.isError).toBe(true);
        expect(emptyDescribe.payload.error).toBe("pipeline is required");
        expect(emptyDescribe.payload.status).toBe(400);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("start_run rejects empty/whitespace pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-start-blank-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));

    try {
      for (const blank of ["", "   "]) {
        const result = await mcpCall(base, "start_run", {
          pipeline: blank,
          task: { id: "t", goal: "g" },
        });
        expect(result.isError).toBe(true);
        expect(result.payload.error).toBe("pipeline is required");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("read_artifact missing → 404; path denied → 400", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-read-art-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const deniedRel = path.join(
      "stages",
      "clarify",
      "attempts",
      "1",
      ".pi-agent",
      "auth.json",
    );
    await mkdir(path.dirname(path.join(created.workspaceDir, deniedRel)), {
      recursive: true,
    });
    await writeFile(
      path.join(created.workspaceDir, deniedRel),
      JSON.stringify({ secret: "nope" }),
    );

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const missingRun = await mcpCall(base, "read_artifact", {
        runId: "does-not-exist",
        path: "stages/clarify/attempts/1/artifacts/note.txt",
      });
      expect(missingRun.isError).toBe(true);
      expect(missingRun.payload.status).toBe(404);
      expect(missingRun.payload.error).toBeTruthy();

      const missingArtifact = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: "stages/clarify/attempts/1/artifacts/missing.txt",
      });
      expect(missingArtifact.isError).toBe(true);
      expect(missingArtifact.payload.status).toBe(404);
      expect(String(missingArtifact.payload.error)).toMatch(/Artifact not found/);

      const denied = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: deniedRel,
      });
      expect(denied.isError).toBe(true);
      expect(denied.payload.status).toBe(400);
      expect(String(denied.payload.error)).toMatch(/Artifact path denied/);

      const escaped = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: "../outside.txt",
      });
      expect(escaped.isError).toBe(true);
      expect(escaped.payload.status).toBe(400);
      expect(String(escaped.payload.error)).toMatch(/\.\.|must not contain/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("list_runs accepts status/since/pipeline filters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-filt-"));
    const store = createRunStore({ rootDir: root });
    const a = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      pipelinePath: path.join(catalogRoot, "pipelines", "docs-only.pipeline.yaml"),
    });
    await store.updateRunStatus(a.runId, "succeeded");
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: t\ngoal: g\n",
      pipelinePath: path.join(catalogRoot, "pipelines", "single.pipeline.yaml"),
    });
    await store.updateRunStatus(b.runId, "failed");

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const all = await mcpCall(base, "list_runs", {});
      expect(all.isError).toBe(false);
      expect(all.payload.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
        b.runId,
        a.runId,
      ]);

      const byStatus = await mcpCall(base, "list_runs", { status: "failed" });
      expect(byStatus.payload.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
        b.runId,
      ]);

      const bySince = await mcpCall(base, "list_runs", { since: cutoff });
      expect(bySince.payload.runs.map((r: { run_id: string }) => r.run_id)).toEqual([
        b.runId,
      ]);

      const byPipeline = await mcpCall(base, "list_runs", {
        pipeline: "docs-only",
      });
      expect(
        byPipeline.payload.runs.map((r: { run_id: string }) => r.run_id),
      ).toEqual([a.runId]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("list_runs rejects invalid since", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-list-since-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));

    try {
      const bad = await mcpCall(base, "list_runs", { since: "not-a-date" });
      expect(bad.isError).toBe(true);
      expect(bad.payload.status).toBe(400);
      expect(bad.payload.error).toBe("since must be a valid date");
      expect(bad.payload.runs).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("MCP Tier 2 wait_run", () => {
  const freeTextPrompt = {
    kind: "free_text" as const,
    id: "prompt-1",
    message: "What should the module name be?",
  };
  const freeTextAnswer = {
    promptId: "prompt-1",
    kind: "free_text" as const,
    text: "payments",
  };

  it("tools/list includes wait_run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-list-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));
    try {
      const tools = await mcpListTools(base);
      expect(tools.map((t) => t.name)).toContain("wait_run");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE1 wake on waiting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-hitl-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      const waited = await mcpCall(base, "wait_run", {
        runId,
        until: "any",
        timeout_ms: 8_000,
      });
      expect(waited.isError).toBe(false);
      expect(waited.payload.reason).toBe("waiting");
      expect(waited.payload.until).toBe("any");
      expect(waited.payload.run.status).toBe("running");
      expect(waited.payload.run.waiting_stage_ids).toContain("clarify");
      expect(
        waited.payload.run.stages.find(
          (s: { stage_id: string }) => s.stage_id === "clarify",
        )?.pending_prompt,
      ).toEqual(freeTextPrompt);
      expect(waited.payload.run.stages[0]?.events).toBeUndefined();

      await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE2 wake on terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-term-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;

      const waited = await mcpCall(base, "wait_run", {
        runId,
        until: "terminal",
        timeout_ms: 8_000,
      });
      expect(waited.isError).toBe(false);
      expect(["terminal", "already"]).toContain(waited.payload.reason);
      expect(waited.payload.run.status).toBe("succeeded");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE3 already waiting / already terminal → reason already", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-already-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const alreadyWaiting = await mcpCall(base, "wait_run", {
        runId,
        until: "waiting",
        timeout_ms: 2_000,
      });
      expect(alreadyWaiting.isError).toBe(false);
      expect(alreadyWaiting.payload.reason).toBe("already");
      expect(alreadyWaiting.payload.elapsed_ms).toBeLessThan(500);

      await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const alreadyTerminal = await mcpCall(base, "wait_run", {
        runId,
        until: "terminal",
        timeout_ms: 2_000,
      });
      expect(alreadyTerminal.isError).toBe(false);
      expect(alreadyTerminal.payload.reason).toBe("already");
      expect(alreadyTerminal.payload.run.status).toBe("succeeded");
      expect(alreadyTerminal.payload.elapsed_ms).toBeLessThan(500);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE4 timeout while still running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-to-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const timedOut = await mcpCall(base, "wait_run", {
        runId,
        until: "terminal",
        timeout_ms: 400,
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.payload.reason).toBe("timeout");
      expect(timedOut.payload.run.status).toBe("running");
      expect(timedOut.payload.elapsed_ms).toBeGreaterThanOrEqual(350);

      await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE5 unknown run → 404; invalid timeout_ms / until → 400", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-err-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));

    try {
      const missing = await mcpCall(base, "wait_run", {
        runId: "no-such-run",
        timeout_ms: 500,
      });
      expect(missing.isError).toBe(true);
      expect(missing.payload.status).toBe(404);

      const badTimeout = await mcpCall(base, "wait_run", {
        runId: "x",
        timeout_ms: 0,
      });
      expect(badTimeout.isError).toBe(true);
      expect(badTimeout.payload.status).toBe(400);

      const badUntilRes = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "wait_run",
            arguments: { runId: "x", until: "nope" },
          },
        }),
      });
      const badUntilText = await badUntilRes.text();
      const badUntilLine = badUntilText
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(badUntilLine).toBeTruthy();
      const badUntilMsg = JSON.parse(badUntilLine!.slice("data: ".length)) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(badUntilMsg.result?.isError).toBe(true);
      expect(badUntilMsg.result?.content?.[0]?.text ?? "").toMatch(/valid|enum|until|invalid/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("AE6 abort ends wait with code aborted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-abort-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const controller = new AbortController();
      const pending = mcpCall(
        base,
        "wait_run",
        { runId, until: "terminal", timeout_ms: 30_000 },
        { signal: controller.signal },
      );
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();

      let aborted = false;
      try {
        const result = await pending;
        if (result.isError && result.payload?.code === "aborted") {
          aborted = true;
        }
      } catch (err) {
        aborted =
          err instanceof Error &&
          (err.name === "AbortError" || /aborted/i.test(err.message));
      }
      expect(aborted).toBe(true);

      const stillWaiting = await store.readRun(runId);
      expect(stillWaiting.status).toBe("running");
      expect(
        stillWaiting.stages.some((s) => s.status === "waiting_for_input"),
      ).toBe(true);

      await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("get_run stays event-free after wait_run wake", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-wait-lean-"));
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
          payload: { n: 1 },
        },
      },
    ]);
    const { server, base } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;

      const waited = await mcpCall(base, "wait_run", {
        runId,
        until: "terminal",
        timeout_ms: 8_000,
      });
      expect(waited.payload.run.stages[0]?.events).toBeUndefined();

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.stages[0]?.events).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
