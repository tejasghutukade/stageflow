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

async function mcpCall(base: string, name: string, args: Record<string, unknown> = {}) {
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
      params: { name, arguments: args },
    }),
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
