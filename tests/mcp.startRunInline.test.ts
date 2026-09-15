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

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

describe("start_run — inline pipeline (MCP)", () => {
  let projectRoot: string;
  let cleanupProject: () => Promise<void>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    projectRoot = setup.root;
    cleanupProject = setup.cleanup;
    await cp(path.join(fixtures, "pipelines"), path.join(projectRoot, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(projectRoot, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(projectRoot, "stages"), {
      recursive: true,
    });
    await writeFile(
      path.join(projectRoot, "stageflow.yaml"),
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
    await cleanupProject();
  });

  it("runs to completion, shows up in list_runs/get_run like a file-based run, no pipeline_path", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-inline-run-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "checked", artifacts: [] },
      },
    ]);
    const { server } = await startUiServer({
      agent,
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: {
          id: "quick-check",
          stages: [
            {
              id: "check",
              system_prompt: "Review the diff for obvious bugs.",
              model: "anthropic/claude-sonnet-4-5",
              ...REQUIRED_IO,
            },
          ],
        },
        task: { id: "t", goal: "check this change" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;
      expect(runId).toBeTruthy();

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.run_id).toBe(runId);
      expect(detail.payload.pipeline_path).toBeUndefined();
      expect(detail.payload.stages[0]?.envelope.summary).toBe("checked");

      const listed = await mcpCall(base, "list_runs", {});
      expect(listed.isError).toBe(false);
      expect(listed.payload.runs.some((r: { run_id: string }) => r.run_id === runId)).toBe(
        true,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("a structurally invalid inline pipeline returns the same ValidationFinding-shaped error a bad file would", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-inline-bad-"));
    const store = createRunStore({ rootDir: storeRoot });
    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // Missing io.output.schema — the exact same defect a bad file would hit.
      const started = await mcpCall(base, "start_run", {
        pipeline: {
          id: "broken",
          stages: [{ id: "check", system_prompt: "Do work" }],
        },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      expect(started.payload.error).toBe("Pipeline validation failed");
      expect(started.payload).toHaveProperty("validation");
      expect(
        started.payload.validation.findings.some(
          (f: { code: string }) => f.code === "stage.invalid_io",
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("uses: on an inline stage is rejected, not treated as a file reference", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-inline-uses-"));
    const store = createRunStore({ rootDir: storeRoot });
    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: {
          id: "with-uses",
          stages: [{ id: "check", uses: "./somewhere.yaml" }],
        },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(true);
      const message = JSON.stringify(started.payload);
      expect(message).toMatch(/uses/);
      expect(message).not.toMatch(/not found/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("rerun on an inline-pipeline run fails with the existing missing-pipeline_path error", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-inline-rerun-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "ok", artifacts: [] } },
    ]);
    const { server } = await startUiServer({
      agent,
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: {
          id: "rerun-demo",
          stages: [
            {
              id: "check",
              system_prompt: "Do work",
              model: "anthropic/claude-sonnet-4-5",
              ...REQUIRED_IO,
            },
          ],
        },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const rerun = await mcpCall(base, "rerun", { runId });
      expect(rerun.isError).toBe(true);
      expect(rerun.payload.error).toMatch(/missing pipeline_path/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("list_pipelines/describe_pipeline are unaffected by an inline-pipeline run having happened", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-inline-catalog-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "ok", artifacts: [] } },
    ]);
    const { server } = await startUiServer({
      agent,
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const before = await mcpCall(base, "list_pipelines");
      expect(before.isError).toBe(false);

      const started = await mcpCall(base, "start_run", {
        pipeline: {
          id: "catalog-leak-check",
          stages: [
            {
              id: "check",
              system_prompt: "Do work",
              model: "anthropic/claude-sonnet-4-5",
              ...REQUIRED_IO,
            },
          ],
        },
        task: { id: "t", goal: "check" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const after = await mcpCall(base, "list_pipelines");
      expect(after.isError).toBe(false);
      // Not a strict equality: fanning out over every known project root can
      // list the same on-disk directory twice under distinct path spellings
      // (a pre-existing quirk unrelated to inline pipelines). What matters
      // here is that nothing from the inline run leaked in.
      const beforePaths = new Set(
        before.payload.pipelines.map((p: { path: string }) => p.path),
      );
      const afterPaths = new Set(
        after.payload.pipelines.map((p: { path: string }) => p.path),
      );
      for (const p of beforePaths) expect(afterPaths.has(p)).toBe(true);
      expect(
        after.payload.pipelines.some(
          (p: { id?: string }) => p.id === "catalog-leak-check",
        ),
      ).toBe(false);

      const describeResult = await mcpCall(base, "describe_pipeline", {
        pipeline: "pipelines/docs-only.pipeline.yaml",
      });
      expect(describeResult.isError).toBe(false);
      expect(describeResult.payload.id).toBe("docs-only");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
