import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { cp, mkdtemp, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
} from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { RunManager } from "../src/runtime/runManager.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { netPipeline } from "./helpers/fixturePaths.js";

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
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data in MCP tools/list: ${text.slice(0, 200)}`);
  }
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };
  return message.result?.tools ?? [];
}

function completedAgent() {
  return {
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
}

describe("start_run surface parity (U2)", () => {
  it("checkout reaches manager; checkout_override alias; XOR; absolute path-contract; description lists params", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-u2-"));
    const store = createRunStore({ rootDir: root });
    await store.ensureProject(catalogRoot);
    const { server } = await startUiServer({
      agent: completedAgent(),
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
    const spy = vi.spyOn(RunManager.prototype, "startRun").mockResolvedValue({
      ok: true,
      runId: "u2-mock-run",
      done: Promise.resolve(),
    });

    try {
      const viaCheckout = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "co", goal: "checkout param" },
        checkout: "pipelines",
      });
      expect(viaCheckout.isError).toBe(false);
      const catalogAbs = await realpath(catalogRoot);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          checkoutOverride: expect.stringMatching(/pipelines$/),
          projectRoot: catalogAbs,
        }),
      );

      spy.mockClear();
      const viaAlias = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "alias", goal: "alias" },
        checkout_override: "pipelines",
      });
      expect(viaAlias.isError).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          checkoutOverride: expect.stringMatching(/pipelines$/),
          projectRoot: catalogAbs,
        }),
      );

      spy.mockRestore();
      const mcpXor = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: {
          id: "xor",
          goal: "both",
          repository: "acme/api",
          ref: "main",
        },
        checkout: "pipelines",
      });
      expect(mcpXor.isError).toBe(true);
      expect(mcpXor.payload.code).toBe("task.binding_conflict");

      const restXor = await jsonFetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: netPipeline("docs-only"),
          task: {
            id: "xor-rest",
            goal: "both",
            repository: "acme/api",
            ref: "main",
          },
          checkoutOverride: "pipelines",
        }),
      });
      expect(restXor.status).toBe(400);
      expect(restXor.body.code).toBe("task.binding_conflict");

      const absMcp = await mcpCall(url, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "abs", goal: "absolute" },
        checkout: "/tmp/does-not-exist-sf-u2",
      });
      expect(absMcp.isError).toBe(true);
      expect(absMcp.payload.code).toBe("absolute_path_not_allowed");
      expect(String(absMcp.payload.error ?? "")).not.toMatch(/ENOENT/i);
      expect(String(absMcp.payload.error ?? "")).not.toMatch(/does not exist/i);

      const absRest = await jsonFetch(`${url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: netPipeline("docs-only"),
          task: { id: "abs-rest", goal: "absolute" },
          checkoutOverride: "/tmp/does-not-exist-sf-u2",
        }),
      });
      expect(absRest.status).toBe(400);
      expect(absRest.body.code).toBe("absolute_path_not_allowed");
      expect(String(absRest.body.error ?? "")).not.toMatch(/ENOENT|does not exist/i);

      const tools = await mcpListTools(url);
      const start = tools.find((t) => t.name === "start_run");
      const desc = start?.description ?? "";
      for (const name of [
        "pipeline",
        "task_path",
        "task",
        "project_root",
        "checkout",
        "checkout_override",
        "skip_gates",
        "git_sha",
        "ci_pr_url",
        "ci_job_url",
        "skills",
      ]) {
        expect(desc).toContain(name);
      }
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("persists wire project_root on MCP and REST (Host boot ≠ wire root)", async () => {
    const boot = await initTempGitRepo();
    const wire = await initTempGitRepo();
    try {
      await cp(path.join(fixtures, "pipelines"), path.join(wire.root, "pipelines"), {
        recursive: true,
      });
      await cp(path.join(fixtures, "tasks"), path.join(wire.root, "tasks"), {
        recursive: true,
      });
      await cp(path.join(fixtures, "stages"), path.join(wire.root, "stages"), {
        recursive: true,
      });
      await writeFile(
        path.join(wire.root, "stageflow.yaml"),
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

      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-u4-"));
      const store = createRunStore({ rootDir: storeRoot });
      const wireAbs = await store.ensureProject(wire.root);

      const { server } = await startUiServer({
        agent: completedAgent(),
        cwd: boot.root,
        rootDir: storeRoot,
        store,
        port: 0,
        uiDistDir: path.join(storeRoot, "missing-ui"),
        mcpStateless: true,
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP");
      const url = `http://127.0.0.1:${address.port}`;
      const bootAbs = path.resolve(boot.root);
      expect(wireAbs).not.toBe(bootAbs);

      try {
        const mcpStarted = await mcpCall(url, "start_run", {
          pipeline: netPipeline("docs-only"),
          task: { id: "u4-mcp", goal: "wire root" },
          project_root: wireAbs,
        });
        expect(mcpStarted.isError).toBe(false);
        const mcpRunId = (mcpStarted.payload as { runId: string }).runId;
        const mcpMeta = await store.readRunMeta(mcpRunId);
        expect(mcpMeta.project_root).toBe(wireAbs);
        expect(mcpMeta.project_root).not.toBe(bootAbs);

        const restStarted = await jsonFetch(`${url}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipeline: netPipeline("docs-only"),
            task: { id: "u4-rest", goal: "wire root" },
            project_root: wireAbs,
          }),
        });
        expect(restStarted.status).toBe(202);
        const restMeta = await store.readRunMeta(restStarted.body.runId as string);
        expect(restMeta.project_root).toBe(wireAbs);
        expect(restMeta.project_root).not.toBe(bootAbs);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      await wire.cleanup();
      await boot.cleanup();
    }
  });
});
