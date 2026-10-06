import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { operatorPromptEvent } from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { RunManager } from "../src/runtime/runManager.js";
import { startUiServer } from "../src/server/http.js";
import type { HttpHostEnvelope } from "../src/server/createHttpHost.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import {
  pipelinePath,
  SAMPLE_TASK,
  SINGLE_PIPELINE,
} from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const successEnvelope = {
  status: "success" as const,
  summary: "ok",
  artifacts: [] as string[],
  payload: {},
};

function okEnvelope(summary: string) {
  return { status: "success" as const, summary, artifacts: [] as string[], payload: {} };
}

function failEnvelope(summary: string) {
  return { status: "failed" as const, summary, artifacts: [] as string[] };
}

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

/** Never actually spawns anything: the test already started a real service. */
const alreadyUp = async () => ({ ok: true as const, alreadyRunning: true as const });

async function startService(
  store: ReturnType<typeof createRunStore>,
  agent: ReturnType<typeof scriptedFakeAgent>,
): Promise<{ server: HttpHostEnvelope; baseUrl: string }> {
  const storeRootForUi = await mkdtemp(path.join(tmpdir(), "sf-runs-mutate-ui-"));
  const server = await startUiServer({
    agent,
    cwd: fixtures,
    store,
    port: 0,
    uiDistDir: path.join(storeRootForUi, "missing-ui"),
    mcpStateless: true,
  });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: HttpHostEnvelope): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("runRunsCommand mutate", () => {
  it("retry a failed stage reaches terminal with sf run completion JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-retry-ok-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const { server, baseUrl } = await startService(
      store,
      scriptedFakeAgent([
        { type: "emit", envelope: okEnvelope("design-ok-retry") },
        { type: "emit", envelope: okEnvelope("plan-ok") },
      ]),
    );
    try {
      const cap = captureIo();
      const code = await runRunsCommand(
        ["retry", "--run", started.runId, "--stage", "design-doc", "--json"],
        {
          cwd: fixtures,
          hostBaseUrl: baseUrl,
          ensureService: alreadyUp,
          io: cap.io,
        },
      );
      expect([0, 2]).toContain(code);
      const parsed = JSON.parse(cap.stdout.join("\n")) as {
        outcome: string;
        runId: string;
      };
      expect(parsed.runId).toBe(started.runId);
      expect(["succeeded", "waiting", "failed"]).toContain(parsed.outcome);
      if (code === 0) expect(parsed.outcome).toBe("succeeded");
      if (code === 2) expect(parsed.outcome).toBe("waiting");
    } finally {
      await closeServer(server);
    }
  });

  it("retry waiting stage exits 1 with hitl_not_retriable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-retry-hitl-"));
    const store = createRunStore({ rootDir: root });
    const prompt: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-1",
      message: "Need input",
    };
    const created = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      pipelineDag: linearCompatDagSnapshot(["clarify"]),
    });
    await store.ensureStageWorkspace(created.runId, "clarify");
    await store.createStageExecution(created.runId, "clarify");
    await store.appendStageEvent(created.runId, "clarify", { event: "started" });
    await store.appendStageEvent(
      created.runId,
      "clarify",
      operatorPromptEvent(prompt),
    );
    await store.appendStageEvent(created.runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.updateRunStatus(created.runId, "running");

    const { server, baseUrl } = await startService(store, scriptedFakeAgent([]));
    try {
      const cap = captureIo();
      const code = await runRunsCommand(
        ["retry", "--run", created.runId, "--stage", "clarify", "--json"],
        {
          cwd: fixtures,
          hostBaseUrl: baseUrl,
          ensureService: alreadyUp,
          io: cap.io,
        },
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.stdout.join("\n")) as {
        error: string;
        code?: string;
        status?: number;
      };
      expect(parsed.code).toBe("hitl_not_retriable");
      expect(parsed.status).toBe(409);
      expect(parsed.error).toMatch(/waiting for input/i);
    } finally {
      await closeServer(server);
    }
  });

  it("no service reachable: retry reports the ensure-service failure without mutating", async () => {
    const cap = captureIo();
    let ensureCalls = 0;
    const code = await runRunsCommand(
      ["retry", "--run", "run-x", "--stage", "clarify", "--json"],
      {
        ensureService: async () => {
          ensureCalls += 1;
          return {
            ok: false,
            reason: "timed_out",
            message: "Timed out waiting for the global Stageflow service to become healthy.",
          };
        },
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(ensureCalls).toBe(1);
    expect(cap.stdout.join("\n")).toMatch(/Timed out waiting/);
  });

  it("rerun complete run starts a new runId and blocks until stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-rerun-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([{ type: "emit", envelope: successEnvelope }]),
      store,
      cwd: fixtures,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const { server, baseUrl } = await startService(
      store,
      scriptedFakeAgent([{ type: "emit", envelope: successEnvelope }]),
    );
    try {
      const cap = captureIo();
      const code = await runRunsCommand(
        ["rerun", "--run", started.runId, "--json"],
        {
          cwd: fixtures,
          hostBaseUrl: baseUrl,
          ensureService: alreadyUp,
          io: cap.io,
        },
      );
      expect([0, 2]).toContain(code);
      const parsed = JSON.parse(cap.stdout.join("\n")) as {
        outcome: string;
        runId: string;
      };
      expect(parsed.runId).not.toBe(started.runId);
      expect(["succeeded", "waiting", "failed"]).toContain(parsed.outcome);
    } finally {
      await closeServer(server);
    }
  });

  it("abandon --json returns { ok, runId, stageId } on a seeded running stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-abandon-"));
    const store = createRunStore({ rootDir: root });

    // Start the service against an empty store first — its boot-time
    // reconcileOrphanedStages() would otherwise immediately fail any
    // "running" stage it finds with no active worker tracking it, which is
    // exactly the (deliberately store-seeded, no real worker) state this
    // test sets up next.
    const { server, baseUrl } = await startService(store, scriptedFakeAgent([]));
    try {
      const created = await store.createRun({
        pipelineId: "test-pipeline",
        taskYaml: "id: a\ngoal: g\n",
        taskId: "a",
        pipelineDag: linearCompatDagSnapshot(["stage-a"]),
      });
      await store.ensureStageWorkspace(created.runId, "stage-a");
      await store.createStageExecution(created.runId, "stage-a");
      await store.appendStageEvent(created.runId, "stage-a", { event: "started" });
      await store.updateRunStatus(created.runId, "running");

      const cap = captureIo();
      const code = await runRunsCommand(
        ["abandon", "--run", created.runId, "--stage", "stage-a", "--json"],
        {
          cwd: fixtures,
          hostBaseUrl: baseUrl,
          ensureService: alreadyUp,
          io: cap.io,
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(cap.stdout.join("\n"))).toEqual({
        ok: true,
        runId: created.runId,
        stageId: "stage-a",
      });
      const after = await store.readRun(created.runId);
      expect(after.stages.find((s) => s.stage_id === "stage-a")?.status).toBe(
        "failed",
      );
    } finally {
      await closeServer(server);
    }
  });

  it("no service reachable: abandon reports the ensure-service failure without mutating", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(
      ["abandon", "--run", "run-x", "--stage", "stage-a"],
      {
        ensureService: async () => ({
          ok: false,
          reason: "port_occupied",
          message: "Port 3847 is already in use by a process that isn't the Stageflow service.",
        }),
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Port 3847 is already in use/);
  });
});
