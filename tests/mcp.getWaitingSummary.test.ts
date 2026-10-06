import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

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

async function mcpCall(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
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
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP response: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    isError: Boolean(message.result?.isError),
    payload: contentText ? JSON.parse(contentText) : null,
  };
}

async function seedProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const setup = await initTempGitRepo();
  await cp(path.join(fixtures, "pipelines"), path.join(setup.root, "pipelines"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "tasks"), path.join(setup.root, "tasks"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "stages"), path.join(setup.root, "stages"), {
    recursive: true,
  });
  await writeFile(
    path.join(setup.root, "stageflow.yaml"),
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
  return setup;
}

function waitingPrompt(id: string) {
  return { kind: "free_text" as const, id, message: `hold ${id}` };
}

async function startWaitingRun(
  base: string,
  pipeline: string,
  projectRoot: string,
) {
  const started = await mcpCall(base, "start_run", {
    pipeline,
    task: { id: "t", goal: "g" },
    project_root: projectRoot,
  });
  expect(started.isError).toBe(false);
  return started.payload.runId as string;
}

describe("get_waiting_summary", () => {
  let projectA: { root: string; cleanup: () => Promise<void> };
  let projectB: { root: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    projectA = await seedProject();
    projectB = await seedProject();
    clearFindProjectRootCacheForTests();
  });

  afterAll(async () => {
    clearFindProjectRootCacheForTests();
    await projectA.cleanup();
    await projectB.cleanup();
  });

  it("returns count/runs across every project when unscoped, and only the documented fields", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-wsum-"));
    const store = createRunStore({ rootDir: storeRoot });
    const rootA = await store.ensureProject(projectA.root);
    const rootB = await store.ensureProject(projectB.root);

    const agentA = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [waitingPrompt("a-1")],
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);
    const agentB = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [waitingPrompt("b-1")],
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);

    const hostA = await startUiServer({
      agent: agentA,
      cwd: projectA.root,
      rootDir: storeRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui-a"),
      mcpStateless: true,
    });
    const addrA = hostA.server.address();
    if (!addrA || typeof addrA === "string") throw new Error("expected TCP address");
    const baseA = `http://127.0.0.1:${addrA.port}`;

    const hostB = await startUiServer({
      agent: agentB,
      cwd: projectB.root,
      rootDir: storeRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui-b"),
      mcpStateless: true,
    });
    const addrB = hostB.server.address();
    if (!addrB || typeof addrB === "string") throw new Error("expected TCP address");
    const baseB = `http://127.0.0.1:${addrB.port}`;

    try {
      const emptyA = await mcpCall(baseA, "get_waiting_summary");
      expect(emptyA.isError).toBe(false);
      expect(emptyA.payload).toEqual({ count: 0, runs: [] });

      const runIdA = await startWaitingRun(
        baseA,
        "pipelines/single.pipeline.yaml",
        rootA,
      );
      await waitFor(async () => {
        const detail = await store.readRun(runIdA);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const runIdB = await startWaitingRun(
        baseB,
        "pipelines/single.pipeline.yaml",
        rootB,
      );
      await waitFor(async () => {
        const detail = await store.readRun(runIdB);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      // Unscoped spans every project.
      const unscoped = await mcpCall(baseA, "get_waiting_summary");
      expect(unscoped.isError).toBe(false);
      expect(unscoped.payload.count).toBe(2);
      expect(unscoped.payload.runs).toEqual(
        expect.arrayContaining([
          { runId: runIdA, stageId: "clarify", kind: "free_text" },
          { runId: runIdB, stageId: "clarify", kind: "free_text" },
        ]),
      );
      for (const item of unscoped.payload.runs) {
        expect(Object.keys(item).sort()).toEqual(["kind", "runId", "stageId"]);
      }

      // runId scopes to just that run.
      const byRunId = await mcpCall(baseA, "get_waiting_summary", { runId: runIdA });
      expect(byRunId.isError).toBe(false);
      expect(byRunId.payload).toEqual({
        count: 1,
        runs: [{ runId: runIdA, stageId: "clarify", kind: "free_text" }],
      });

      // path scopes to just that project.
      const byPathA = await mcpCall(baseA, "get_waiting_summary", { path: projectA.root });
      expect(byPathA.isError).toBe(false);
      expect(byPathA.payload).toEqual({
        count: 1,
        runs: [{ runId: runIdA, stageId: "clarify", kind: "free_text" }],
      });

      const byPathB = await mcpCall(baseA, "get_waiting_summary", { path: projectB.root });
      expect(byPathB.isError).toBe(false);
      expect(byPathB.payload).toEqual({
        count: 1,
        runs: [{ runId: runIdB, stageId: "clarify", kind: "free_text" }],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        hostA.server.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        hostB.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
