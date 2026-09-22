import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { cp, mkdtemp, readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { describePipeline } from "../src/config/describePipeline.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { projectRunDetail } from "../src/runstore/runProjection.js";
import { startUiServer } from "../src/server/http.js";
import { projectRunForMcp } from "../src/mcp/projectRun.js";
import { readRunArtifact } from "../src/mcp/readArtifact.js";
import { runResourceUri } from "../src/mcp/resources.js";
import type { RunPipelineDagSnapshot, RunStore } from "../src/runstore/port.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { RunManager } from "../src/runtime/runManager.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { seedDiamondRun } from "./helpers/seedDiamondRun.js";

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

async function mcpRpc(
  base: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP ${method}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice("data: ".length)) as {
    result?: {
      contents?: Array<{ text?: string }>;
    };
    error?: unknown;
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
        version: PACKAGE_VERSION,
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

  it("list_pipelines/list_tasks span every project this host has recorded a run for", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-multiproj-"));
    const store = createRunStore({ rootDir: root });

    const { root: repoA, cleanup: cleanupA } = await initTempGitRepo();
    await cp(path.join(fixtures, "pipelines"), path.join(repoA, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(repoA, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(repoA, "stages"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoA, "stageflow.yaml"),
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

    const { root: repoB, cleanup: cleanupB } = await initTempGitRepo();
    await cp(path.join(fixtures, "pipelines"), path.join(repoB, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(repoB, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(repoB, "stages"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoB, "stageflow.yaml"),
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

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "a", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "b", artifacts: [] } },
    ]);

    // Host is launched pointed at repoA; repoB is only ever reached via an
    // absolute pipeline path in start_run — proves list_pipelines/list_tasks
    // pick it up from the run store alone, not from the host's own cwd.
    const { server } = await startUiServer({
      agent,
      cwd: repoA,
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

      const startedA = await mcpCall(base, "start_run", {
        pipeline: path.join(repoA, "pipelines", "single.pipeline.yaml"),
        task: { id: "a-task", goal: "project a" },
      });
      expect(startedA.isError).toBe(false);
      await waitUntilIdleHealth(base);

      const startedB = await mcpCall(base, "start_run", {
        pipeline: path.join(repoB, "pipelines", "single.pipeline.yaml"),
        task: { id: "b-task", goal: "project b" },
      });
      expect(startedB.isError).toBe(false);
      await waitUntilIdleHealth(base);

      const realRepoA = await realpath(repoA);
      const realRepoB = await realpath(repoB);

      const pipelines = await mcpCall(base, "list_pipelines");
      expect(pipelines.isError).toBe(false);
      const roots = new Set(
        pipelines.payload.pipelines.map((p: { project_root: string }) => p.project_root),
      );
      expect(roots.has(realRepoA)).toBe(true);
      expect(roots.has(realRepoB)).toBe(true);

      const tasks = await mcpCall(base, "list_tasks");
      expect(tasks.isError).toBe(false);
      const taskRoots = new Set(
        tasks.payload.tasks.map((t: { project_root: string }) => t.project_root),
      );
      expect(taskRoots.has(realRepoA)).toBe(true);
      expect(taskRoots.has(realRepoB)).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await cleanupA();
      await cleanupB();
    }
  }, 15000);

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

  it("get_health includes version matching PACKAGE_VERSION", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-ver-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));
    try {
      const health = await mcpCall(base, "get_health");
      expect(health.isError).toBe(false);
      expect(health.payload.version).toBe(PACKAGE_VERSION);
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

  it("projectRunForMcp copies cost and definition_id when the store snapshot has them", () => {
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "clone-chain",
        created_at: "t",
        status: "succeeded",
      },
      [
        {
          stage_id: "author-diagrams~2",
          definition_id: "author-diagrams",
          status: "succeeded",
          events: [{ event: "started" }, { event: "succeeded" }],
          envelope: { status: "success", summary: "ok", artifacts: [] },
          artifacts: [],
          cost_usd: 0.0123,
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRunForMcp(detail);
    expect(projected.total_cost_usd).toBe(0.0123);
    expect(projected.stages[0]?.cost_usd).toBe(0.0123);
    expect(projected.stages[0]?.definition_id).toBe("author-diagrams");
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
  });

  it("projectRunForMcp omits unused cost rather than inventing 0", () => {
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
          envelope: { status: "success", summary: "ok", artifacts: [] },
          artifacts: [],
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRunForMcp(detail);
    expect(projected).not.toHaveProperty("total_cost_usd");
    expect(projected.stages[0]).not.toHaveProperty("cost_usd");
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
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

type FeedbackFakeBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function feedbackStageKeyedAgent(
  behaviorsByStage: Record<string, FeedbackFakeBehavior[]>,
): AgentPort {
  const stageIndex = new Map<string, number>();
  return {
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
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

      const clarifyEvents = await mcpCall(base, "list_stage_events", {
        runId,
        stageId: "clarify",
      });
      expect(clarifyEvents.isError).toBe(false);
      const hitlEvents = clarifyEvents.payload.events as Array<{
        event: string;
      }>;
      expect(hitlEvents.some((e) => e.event === "operator_prompt")).toBe(true);
      expect(hitlEvents.some((e) => e.event === "operator_answer")).toBe(true);
      expect(hitlEvents.some((e) => e.event === "feedback_loop_decided")).toBe(
        false,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("list_waiting surfaces feedback_loop_decision; decide_feedback_loop continue succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-fb-dec-"));
    const sendBack: StageEnvelope = {
      status: "success",
      summary: "send-back",
      artifacts: [],
      feedback_loop: { action: "send_back", target: "implement" },
    };
    const agent = feedbackStageKeyedAgent({
      plan: [
        {
          type: "emit",
          envelope: { status: "success", summary: "plan-ok", artifacts: [] },
        },
      ],
      implement: [
        {
          type: "emit",
          envelope: { status: "success", summary: "implement-1", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "implement-2", artifacts: [] },
        },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [
        {
          type: "emit",
          envelope: { status: "success", summary: "submit-ok", artifacts: [] },
        },
      ],
    });
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: pipelinePath("feedback-loop-wait-human"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.active_feedback_loop?.state === "waiting_for_human";
      });

      const listed = await mcpCall(base, "list_waiting", { runId });
      expect(listed.isError).toBe(false);
      expect(listed.payload.waiting).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            stageId: "review",
            waiting_kind: "feedback_loop_decision",
            deferred_target: "implement",
          }),
        ]),
      );
      const gates = listed.payload.waiting as Array<{
        stageId?: string;
        feedback_loop_id?: string;
      }>;
      const loopId = gates.find((g) => g.stageId === "review")?.feedback_loop_id;
      expect(loopId).toBeTruthy();

      const decided = await mcpCall(base, "decide_feedback_loop", {
        runId,
        stageId: "review",
        decision: "continue",
        loopId,
        reason: "ship the brief",
      });
      expect(decided.isError).toBe(false);
      expect(decided.payload).toEqual({
        ok: true,
        effect: "continued",
        loopId,
      });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const listedEvents = await mcpCall(base, "list_stage_events", {
        runId,
        stageId: "review",
      });
      expect(listedEvents.isError).toBe(false);
      const events = listedEvents.payload.events as Array<{
        event: string;
        decision?: string;
        loopId?: string;
        reason?: string;
      }>;
      const names = events.map((e) => e.event);
      const waitIdx = names.lastIndexOf("waiting_for_input");
      const decidedIdx = names.indexOf("feedback_loop_decided", waitIdx + 1);
      const succeededIdx = names.indexOf("succeeded", decidedIdx + 1);
      expect(decidedIdx).toBeGreaterThan(waitIdx);
      expect(succeededIdx).toBeGreaterThan(decidedIdx);
      expect(events[decidedIdx]).toMatchObject({
        event: "feedback_loop_decided",
        decision: "continue",
        loopId,
        reason: "ship the brief",
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

      await store.upsertVerificationCheckResult(runId, "clarify", {
        check_id: "handoff",
        check_type: "payload_schema",
        status: "passed",
        evidence: { kind: "payload_schema", schema_declared: true },
      });
      const verification = await mcpCall(base, "get_stage_verification", {
        runId,
        stageId: "clarify",
      });
      expect(verification.isError).toBe(false);
      expect(verification.payload.attempts[0].checks).toEqual([
        expect.objectContaining({ check_id: "handoff", status: "passed" }),
      ]);

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
      expect(envelope.payload).not.toHaveProperty("attempt");

      await store.writeEnvelope(
        runId,
        "clarify",
        {
          status: "success",
          summary: "attempt-1-prior",
          artifacts: [],
          payload: { n: 1 },
        },
        { attempt: 1 },
      );
      const second = await store.createStageExecution(runId, "clarify");
      expect(second.attempt).toBe(2);
      await store.writeEnvelope(
        runId,
        "clarify",
        {
          status: "success",
          summary: "attempt-2-latest",
          artifacts: [],
          payload: { n: 2 },
        },
        { attempt: 2 },
      );

      const latest = await mcpCall(base, "get_envelope", {
        runId,
        stageId: "clarify",
      });
      expect(latest.isError).toBe(false);
      expect(latest.payload.envelope.summary).toBe("attempt-2-latest");
      expect(latest.payload).not.toHaveProperty("attempt");

      const prior = await mcpCall(base, "get_envelope", {
        runId,
        stageId: "clarify",
        attempt: 1,
      });
      expect(prior.isError).toBe(false);
      expect(prior.payload.attempt).toBe(1);
      expect(prior.payload.envelope.summary).toBe("attempt-1-prior");

      const missingAttempt = await mcpCall(base, "get_envelope", {
        runId,
        stageId: "clarify",
        attempt: 99,
      });
      expect(missingAttempt.isError).toBe(true);
      expect(missingAttempt.payload.status).toBe(404);

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

      const diamondPath = pipelinePath("diamond-fan-in");
      const described = await mcpCall(base, "describe_pipeline", {
        pipeline: diamondPath,
      });
      expect(described.isError).toBe(false);
      expect(described.payload).toEqual(
        describePipeline(await loadPipeline(diamondPath, { cwd: catalogRoot })),
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

  it("describe_pipeline payload equals describePipeline helper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-describe-eq-"));
    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]));

    try {
      for (const name of [
        "diamond-fan-in",
        "clone-chain-smallest",
        "route-if-eq",
        "route-loop-basic",
      ]) {
        const pipeline = pipelinePath(name);
        const described = await mcpCall(base, "describe_pipeline", { pipeline });
        expect(described.isError).toBe(false);
        expect(described.payload).toEqual(
          describePipeline(await loadPipeline(pipeline, { cwd: catalogRoot })),
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("describe_pipeline does not import graph ASCII", async () => {
    const src = await readFile(
      new URL("../src/mcp/catalogTools.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/renderGraph|graphRender|graphCommand/);
  });

  it("get_run diamond pipeline_track has both inbound synthesize edges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-get-diamond-"));
    const store = createRunStore({ rootDir: root });
    const { runId } = await seedDiamondRun(store, "diamond-fan-in", {
      clarify: "succeeded",
      research: "succeeded",
      validation: "pending",
      synthesize: "pending",
    });
    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.pipeline_track.edges.filter((e: { to: string }) => e.to === "synthesize")).toEqual([
        { from: "research", to: "synthesize" },
        { from: "validation", to: "synthesize" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("get_run accepted-failure success projects succeeded, not failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-get-accepted-"));
    const store = createRunStore({ rootDir: root });
    const { runId } = await seedDiamondRun(
      store,
      "diamond-fan-in-accepted",
      {
        clarify: "succeeded",
        research: "failed",
        validation: "succeeded",
        synthesize: "succeeded",
      },
      "succeeded",
    );
    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.status).toBe("succeeded");
      expect(
        detail.payload.stages.find((s: { stage_id: string }) => s.stage_id === "research")
          ?.status,
      ).toBe("failed");
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

  it("read_artifact returns UTF-8 text as JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-read-txt-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "clarify",
      "attempts",
      "1",
      "artifacts",
      "note.txt",
    );
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), "hello artifact", "utf8");

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const result = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: rel,
      });
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual({
        runId: created.runId,
        path: rel,
        content: "hello artifact",
      });
      expect(result.raw.result?.content?.[0]?.type).toBe("text");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("read_artifact returns MCP image content for a png", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-read-png-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "screenshot",
      "attempts",
      "1",
      "artifacts",
      "page.png",
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), png);

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const result = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: rel,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0]?.type).toBe("image");
      expect(result.content[0]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: png.toString("base64"),
      });
      expect(result.payload).toEqual({
        runId: created.runId,
        path: rel,
        mimeType: "image/png",
      });
      expect(result.payload).not.toHaveProperty("data");
      expect(JSON.stringify(result.payload)).not.toContain(png.toString("base64"));
      expect(result.content[1]?.text).not.toContain(png.toString("base64"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("read_artifact returns 400 for non-UTF-8 non-image bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-read-bin-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "clarify",
      "attempts",
      "1",
      "artifacts",
      "blob.zip",
    );
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]);
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), zip);

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const result = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: rel,
      });
      expect(result.isError).toBe(true);
      expect(result.payload.status).toBe(400);
      expect(String(result.payload.error)).toMatch(/UTF-8|binary/i);
      expect(String(result.payload.error)).not.toContain("\uFFFD");
      expect(JSON.stringify(result.payload)).not.toContain(zip.toString("base64"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("read_artifact denies a png under .pi-agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-read-png-deny-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
    });
    const rel = path.join(
      "stages",
      "screenshot",
      "attempts",
      "1",
      ".pi-agent",
      "page.png",
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(path.dirname(path.join(created.workspaceDir, rel)), {
      recursive: true,
    });
    await writeFile(path.join(created.workspaceDir, rel), png);

    const { server, base } = await withMcpServer(
      root,
      scriptedFakeAgent([]),
      store,
    );

    try {
      const result = await mcpCall(base, "read_artifact", {
        runId: created.runId,
        path: rel,
      });
      expect(result.isError).toBe(true);
      expect(result.payload.status).toBe(400);
      expect(String(result.payload.error)).toMatch(/Artifact path denied/);
      expect(result.raw.result?.content?.[0]?.type).not.toBe("image");
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
      expect(tools.map((t) => t.name)).toContain("resume_stage");
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

function cloneInstanceDag(): RunPipelineDagSnapshot {
  return {
    stage_ids: ["author-diagrams~2"],
    roots: ["author-diagrams~2"],
    childrenOf: {},
    nodes: [
      {
        id: "author-diagrams~2",
        needs: null,
        needsEdges: [],
        ancestors: [],
        stageIndex: 0,
        definition_id: "author-diagrams",
      },
    ],
  };
}

async function seedSucceededStage(
  store: RunStore,
  runId: string,
  stageId: string,
  opts: { cost_usd?: number } = {},
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 1 });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt: 1 });
  await store.updateStageExecution(runId, stageId, 1, {
    status: "succeeded",
    envelope: { status: "success", summary: "ok", artifacts: [] },
    ...(opts.cost_usd !== undefined ? { cost_usd: opts.cost_usd } : {}),
  });
}

async function readRunResourcePayload(base: string, runId: string) {
  const read = await mcpRpc(base, "resources/read", {
    uri: runResourceUri(runId),
  });
  const text = read.result?.contents?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown> & {
    stages: Array<Record<string, unknown>>;
  };
}

describe("MCP lean run projection fields", () => {
  it("get_run, wait_run nested run, and run resource share cost and definition_id omit-or-present rules", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-lean-cost-"));
    const store = createRunStore({ rootDir: root });
    const withCost = await store.createRun({
      pipelineId: "clone-chain",
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: cloneInstanceDag(),
    });
    await seedSucceededStage(store, withCost.runId, "author-diagrams~2", {
      cost_usd: 0.0123,
    });
    const unused = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await seedSucceededStage(store, unused.runId, "clarify");

    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]), store);
    try {
      const getWithCost = await mcpCall(base, "get_run", { runId: withCost.runId });
      const waitWithCost = await mcpCall(base, "wait_run", {
        runId: withCost.runId,
        until: "terminal",
        timeout_ms: 2_000,
      });
      const resourceWithCost = await readRunResourcePayload(base, withCost.runId);

      expect(getWithCost.isError).toBe(false);
      expect(waitWithCost.isError).toBe(false);
      expect(getWithCost.payload.total_cost_usd).toBe(0.0123);
      expect(waitWithCost.payload.run.total_cost_usd).toBe(0.0123);
      expect(resourceWithCost.total_cost_usd).toBe(0.0123);

      const costStage = getWithCost.payload.stages.find(
        (s: { stage_id: string }) => s.stage_id === "author-diagrams~2",
      );
      const waitStage = waitWithCost.payload.run.stages.find(
        (s: { stage_id: string }) => s.stage_id === "author-diagrams~2",
      );
      const resourceStage = resourceWithCost.stages.find(
        (s) => s.stage_id === "author-diagrams~2",
      );
      expect(costStage?.cost_usd).toBe(0.0123);
      expect(costStage?.definition_id).toBe("author-diagrams");
      expect(costStage?.events).toBeUndefined();
      expect(waitStage?.cost_usd).toBe(0.0123);
      expect(waitStage?.definition_id).toBe("author-diagrams");
      expect(waitStage?.events).toBeUndefined();
      expect(resourceStage?.cost_usd).toBe(0.0123);
      expect(resourceStage?.definition_id).toBe("author-diagrams");
      expect(resourceStage?.events).toBeUndefined();
      expect(getWithCost.payload.task_yaml).toBeUndefined();
      expect(waitWithCost.payload.run.task_yaml).toBeUndefined();
      expect(resourceWithCost.task_yaml).toBeUndefined();

      const getUnused = await mcpCall(base, "get_run", { runId: unused.runId });
      const waitUnused = await mcpCall(base, "wait_run", {
        runId: unused.runId,
        until: "terminal",
        timeout_ms: 2_000,
      });
      const resourceUnused = await readRunResourcePayload(base, unused.runId);

      expect(getUnused.payload.total_cost_usd).toBeUndefined();
      expect(waitUnused.payload.run.total_cost_usd).toBeUndefined();
      expect(resourceUnused.total_cost_usd).toBeUndefined();
      expect(getUnused.payload.stages[0]?.cost_usd).toBeUndefined();
      expect(waitUnused.payload.run.stages[0]?.cost_usd).toBeUndefined();
      expect(resourceUnused.stages[0]?.cost_usd).toBeUndefined();
      expect(getUnused.payload.stages[0]?.events).toBeUndefined();
      expect(waitUnused.payload.run.stages[0]?.events).toBeUndefined();
      expect(resourceUnused.stages[0]?.events).toBeUndefined();
      expect(getUnused.payload.task_yaml).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("MCP start_run repository binding (U7)", () => {
  it("accepts repository task, rejects token fields, and forwards skip_gates/checkout_override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-u7-"));
    const store = createRunStore({ rootDir: root });
    const agent = {
      openStage(input: { stage: { id: string } }) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => ({
            ok: true as const,
            envelope: {
              status: "success" as const,
              summary: "ok",
              artifacts: [],
              payload: {},
            },
          }),
        });
      },
      async runStage() {
        return {
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
            payload: {},
          },
        };
      },
    };
    const { server } = await startUiServer({
      agent,
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    const url = `http://127.0.0.1:${address.port}`;

    const spy = vi.spyOn(RunManager.prototype, "startRun");
    try {
      const tokenReject = await mcpCall(url, "start_run", {
        pipeline: pipelinePath("docs-only"),
        task: { id: "tok", goal: "nope" },
        github_token: "should-not-work",
      });
      expect(tokenReject.isError).toBe(true);
      expect(tokenReject.payload.code).toBe("start.token_rejected");
      expect(tokenReject.payload.field).toBe("github_token");

      const conflict = await mcpCall(url, "start_run", {
        pipeline: pipelinePath("docs-only"),
        task: {
          id: "conflict",
          goal: "both",
          repository: "acme/api",
          ref: "main",
        },
        checkout_override: "/tmp/some-path",
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.payload.code).toBe("task.binding_conflict");

      const skipCall = await mcpCall(url, "start_run", {
        pipeline: pipelinePath("docs-only"),
        task: { id: "skip", goal: "gates" },
        skip_gates: true,
        git_sha: "abc",
        ci_pr_url: "https://example.com/pr/1",
        ci_job_url: "https://example.com/job/1",
      });
      expect(skipCall.isError).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          skipGates: true,
          gitSha: "abc",
          ciPrUrl: "https://example.com/pr/1",
          ciJobUrl: "https://example.com/job/1",
        }),
      );
      await waitUntilIdleHealth(url);

      const tools = await mcpListTools(url);
      const start = tools.find((t) => t.name === "start_run");
      expect(start?.description).toMatch(/path-checkout lease|skip_gates|token/i);

      const rerunSpy = vi.spyOn(RunManager.prototype, "rerun").mockResolvedValue({
        ok: false,
        reason: "stopped",
        status: 400,
      });
      await mcpCall(url, "rerun", { runId: "missing", pinned: true });
      expect(rerunSpy).toHaveBeenCalledWith("missing", { pinned: true });
      rerunSpy.mockRestore();
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

