import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { attemptStreamLogPath } from "../src/runstore/workspaceLayout.js";
import { encodeStreamLogHeader } from "../src/runtime/stageStreamLog.js";
import { readStreamLogTail } from "../src/mcp/tailStreamLog.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

async function writeFixtureLog(base: number, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-tail-fixture-"));
  const streamLogPath = path.join(dir, "stream.log");
  await writeFile(streamLogPath, encodeStreamLogHeader(base) + content, "utf8");
  return streamLogPath;
}

describe("readStreamLogTail", () => {
  it("returns the whole retained window when since_offset is omitted", async () => {
    const streamLogPath = await writeFixtureLog(0, "hello world");
    const tail = await readStreamLogTail(streamLogPath, undefined);
    expect(tail).toEqual({ text: "hello world", nextOffset: 11 });
  });

  it("returns a normal in-range slice", async () => {
    const streamLogPath = await writeFixtureLog(0, "hello world");
    const tail = await readStreamLogTail(streamLogPath, 6);
    expect(tail).toEqual({ text: "world", nextOffset: 11 });
  });

  it("returns an empty read exactly at EOF", async () => {
    const streamLogPath = await writeFixtureLog(0, "hello world");
    const tail = await readStreamLogTail(streamLogPath, 11);
    expect(tail).toEqual({ text: "", nextOffset: 11 });
  });

  it("returns empty text, no error, when the caller races ahead of the current EOF", async () => {
    const streamLogPath = await writeFixtureLog(0, "hello world");
    const tail = await readStreamLogTail(streamLogPath, 999);
    expect(tail).toEqual({ text: "", nextOffset: 11 });
  });

  it("flags truncated and serves from the current base when since_offset predates it", async () => {
    const streamLogPath = await writeFixtureLog(500, "recent text only");
    const tail = await readStreamLogTail(streamLogPath, 100);
    expect(tail).toEqual({
      text: "recent text only",
      nextOffset: 500 + "recent text only".length,
      truncated: true,
      earliestOffset: 500,
    });
  });

  it("respects a non-zero base for an in-range read", async () => {
    const content = "recent text only";
    const streamLogPath = await writeFixtureLog(500, content);
    const tail = await readStreamLogTail(streamLogPath, 507);
    expect(tail).toEqual({
      text: "text only",
      nextOffset: 500 + content.length,
    });
  });

  it("returns empty text, no error, when the file doesn't exist yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-tail-missing-"));
    const tail = await readStreamLogTail(path.join(dir, "stream.log"), undefined);
    expect(tail).toEqual({ text: "", nextOffset: 0 });
  });
});

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

describe("tail_stage_log (MCP)", () => {
  let projectRoot: string;
  let cleanupProject: () => Promise<void>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    projectRoot = setup.root;
    cleanupProject = setup.cleanup;
  });

  afterAll(async () => {
    await cleanupProject();
  });

  // The run is created before the service boots; the stage is marked
  // "running" only after boot so bootstrapStageflowHost's one-time
  // reconcileOrphanedStages() (which fails any pre-existing "running" stage
  // with no active-worker tracking) never sees it.
  async function createRun(store: ReturnType<typeof createRunStore>) {
    return store.createRun({
      pipelineId: "demo",
      taskYaml: "id: t\ngoal: g\n",
    });
  }

  async function markStageRunning(
    store: ReturnType<typeof createRunStore>,
    runId: string,
  ) {
    await store.appendStageEvent(runId, "work", { event: "started" });
  }

  it("reads a fixture stream.log over real MCP/HTTP, with attempt_complete reflecting stage status", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-tail-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await createRun(store);

    const streamLogPath = attemptStreamLogPath(run.workspaceDir, "work", 1);
    await mkdir(path.dirname(streamLogPath), { recursive: true });
    await writeFile(streamLogPath, encodeStreamLogHeader(0) + "hello from the stage", "utf8");

    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    await markStageRunning(store, run.runId);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const first = await mcpCall(base, "tail_stage_log", { runId: run.runId, stageId: "work" });
      expect(first.isError).toBe(false);
      expect(first.payload).toEqual({
        text: "hello from the stage",
        next_offset: "hello from the stage".length,
        attempt_complete: false,
      });

      const second = await mcpCall(base, "tail_stage_log", {
        runId: run.runId,
        stageId: "work",
        since_offset: first.payload.next_offset,
      });
      expect(second.isError).toBe(false);
      expect(second.payload).toEqual({
        text: "",
        next_offset: first.payload.next_offset,
        attempt_complete: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns truncated:true and earliest_offset when since_offset predates the retained window", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-tail-trunc-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await createRun(store);

    const streamLogPath = attemptStreamLogPath(run.workspaceDir, "work", 1);
    await mkdir(path.dirname(streamLogPath), { recursive: true });
    await writeFile(streamLogPath, encodeStreamLogHeader(1000) + "only the tail remains", "utf8");

    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    await markStageRunning(store, run.runId);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const result = await mcpCall(base, "tail_stage_log", {
        runId: run.runId,
        stageId: "work",
        since_offset: 10,
      });
      expect(result.isError).toBe(false);
      expect(result.payload.truncated).toBe(true);
      expect(result.payload.earliest_offset).toBe(1000);
      expect(result.payload.text).toBe("only the tail remains");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns empty text, no error, when the stage hasn't produced any assistant text yet", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-tail-empty-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await createRun(store);

    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });
    await markStageRunning(store, run.runId);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const result = await mcpCall(base, "tail_stage_log", { runId: run.runId, stageId: "work" });
      expect(result.isError).toBe(false);
      expect(result.payload).toEqual({ text: "", next_offset: 0, attempt_complete: false });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("404s on an unknown runId", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-tail-404run-"));
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
      const result = await mcpCall(base, "tail_stage_log", {
        runId: "does-not-exist",
        stageId: "work",
      });
      expect(result.isError).toBe(true);
      expect(result.payload.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("404s on an unknown stageId", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-mcp-tail-404stage-"));
    const store = createRunStore({ rootDir: storeRoot });
    const run = await createRun(store);

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
      const result = await mcpCall(base, "tail_stage_log", {
        runId: run.runId,
        stageId: "does-not-exist",
      });
      expect(result.isError).toBe(true);
      expect(result.payload.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
