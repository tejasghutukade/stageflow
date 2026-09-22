import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { OPERATOR_CANCEL_REASON } from "../src/runtime/stageRecovery.js";
import { startUiServer } from "../src/server/http.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const fixtures = FIXTURES_ROOT;

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
  };
}

async function withServer(root: string) {
  const store = createRunStore({ rootDir: root });
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: fixtures,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    mcpStateless: true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    store,
    server: started.server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

describe("MCP/REST/CLI cancel_run lifecycle", () => {
  it("MCP cancel_run terminalizes a running stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cancel-"));
    const { store, server, base } = await withServer(root);
    try {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.appendStageEvent(planted.runId, "build", {
        event: "started",
      });
      await store.updateRunStatus(planted.runId, "running");

      const cancelled = await mcpCall(base, "cancel_run", {
        runId: planted.runId,
        reason: "mcp stop",
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.payload).toEqual({
        ok: true,
        runId: planted.runId,
      });

      const detail = await store.readRun(planted.runId);
      expect(detail.status).toBe("cancelled");
      expect(detail.cancel_reason).toBe("mcp stop");
      expect(detail.stages.find((s) => s.stage_id === "build")?.status).toBe(
        "failed",
      );
      const events = await store.listStageEvents(planted.runId, "build");
      expect(events.find((e) => e.event === "failed")?.reason).toBe(
        OPERATOR_CANCEL_REASON,
      );

      const again = await mcpCall(base, "cancel_run", {
        runId: planted.runId,
        reason: "again",
      });
      expect(again.isError).toBe(false);
      expect(again.payload).toEqual({ ok: true, runId: planted.runId });

      const succeeded = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.updateRunStatus(succeeded.runId, "succeeded");
      const conflict = await mcpCall(base, "cancel_run", {
        runId: succeeded.runId,
        reason: "nope",
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.payload.status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("REST POST /api/runs/:runId/cancel returns 202", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rest-cancel-"));
    const { store, server, base } = await withServer(root);
    try {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.appendStageEvent(planted.runId, "build", {
        event: "started",
      });
      await store.updateRunStatus(planted.runId, "running");

      const res = await fetch(`${base}/api/runs/${planted.runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "rest stop" }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        ok: true,
        runId: planted.runId,
      });

      const detail = await store.readRun(planted.runId);
      expect(detail.status).toBe("cancelled");
      expect(detail.cancel_reason).toBe("rest stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("CLI sf runs cancel reaches the same cancelRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-cancel-"));
    const { store, server, base } = await withServer(root);
    try {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.appendStageEvent(planted.runId, "build", {
        event: "started",
      });
      await store.updateRunStatus(planted.runId, "running");

      const cap = captureIo();
      const code = await runRunsCommand(
        [
          "cancel",
          "--run",
          planted.runId,
          "--reason",
          "cli stop",
          "--json",
        ],
        {
          cwd: fixtures,
          hostBaseUrl: base,
          ensureService: async () => ({
            ok: true as const,
            alreadyRunning: true as const,
          }),
          io: cap.io,
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(cap.stdout.join("\n"))).toEqual({
        ok: true,
        runId: planted.runId,
      });

      const detail = await store.readRun(planted.runId);
      expect(detail.status).toBe("cancelled");
      expect(detail.cancel_reason).toBe("cli stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("abandon_stage description no longer denies run-level cancel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-abandon-desc-"));
    const { server, base } = await withServer(root);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      const text = await res.text();
      const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeTruthy();
      const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
        result?: { tools?: Array<{ name: string; description?: string }> };
      };
      const abandon = payload.result?.tools?.find((t) => t.name === "abandon_stage");
      const cancel = payload.result?.tools?.find((t) => t.name === "cancel_run");
      expect(abandon?.description).toBeTruthy();
      expect(abandon!.description).not.toMatch(/no run-level cancel/i);
      expect(abandon!.description).toMatch(/cancel_run/);
      expect(cancel?.description).toBeTruthy();
      expect(cancel!.description).toMatch(/process-group kill is not fixed/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
