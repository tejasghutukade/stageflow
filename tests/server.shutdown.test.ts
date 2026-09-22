import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { storeRootFor } from "../src/runstore/paths.js";
import {
  HOST_EXIT,
  ShutdownController,
  parseShutdownGraceMs,
  workerBudgetMs,
  DEFAULT_SHUTDOWN_GRACE_MS,
  CHECKPOINT_RESERVE_MS,
} from "../src/server/shutdown.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const mockWorker = fileURLToPath(
  new URL("./fixtures/mockStageWorker.mjs", import.meta.url),
);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function listen(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("shutdown grace helpers", () => {
  it("defaults STAGEFLOW_SHUTDOWN_GRACE_MS to 8000", () => {
    expect(parseShutdownGraceMs({})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(parseShutdownGraceMs({ STAGEFLOW_SHUTDOWN_GRACE_MS: "" })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
    expect(parseShutdownGraceMs({ STAGEFLOW_SHUTDOWN_GRACE_MS: "12000" })).toBe(
      12000,
    );
    expect(workerBudgetMs(DEFAULT_SHUTDOWN_GRACE_MS)).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS - CHECKPOINT_RESERVE_MS,
    );
  });
});

describe("ShutdownController", () => {
  const controllers: ShutdownController[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const c of controllers.splice(0)) {
      c.uninstall();
    }
    for (const s of servers.splice(0)) {
      try {
        await closeServer(s);
      } catch {
        // already closed by drain
      }
    }
  });

  it("idle drain exits 0 and checkpoints the store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-idle-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    const server = await listen();
    servers.push(server);
    const controller = new ShutdownController({
      server,
      manager,
      store,
      graceMs: 500,
      installSignals: false,
    });
    controllers.push(controller);

    const started = Date.now();
    const outcome = await controller.beginDrain();
    expect(outcome.exitCode).toBe(HOST_EXIT.CLEAN);
    expect(outcome.forced).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);

    const walPath = path.join(storeRootFor(root), "state.db-wal");
    try {
      const wal = await stat(walPath);
      expect(wal.size).toBeLessThan(64 * 1024);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    const reopened = createRunStore({ rootDir: root, kind: "sqlite" });
    const listed = await reopened.listRuns();
    expect(listed.length).toBe(1);
    await reopened.close();
  });

  it("stopAcceptingWork rejects start/rerun with shutting_down", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-gate-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    manager.stopAcceptingWork();
    const start = await manager.startRun({
      task: { id: "t", goal: "g" },
      pipeline: { id: "p", stages: [{ id: "s", prompt: "hi" }] },
    });
    expect(start.ok).toBe(false);
    if (!start.ok) {
      expect(start.status).toBe(503);
      expect(start.code).toBe("shutting_down");
    }
    const rerun = await manager.rerun("missing");
    expect(rerun.ok).toBe(false);
    if (!rerun.ok) {
      expect(rerun.status).toBe(503);
      expect(rerun.code).toBe("shutting_down");
    }
    await store.close();
  });

  it("stopAcceptingWork rejects resume/retry with shutting_down", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-resume-gate-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    manager.stopAcceptingWork();
    const resume = await manager.resumeTimedOutStage("missing", "s");
    expect(resume.ok).toBe(false);
    if (!resume.ok) {
      expect(resume.status).toBe(503);
      expect(resume.code).toBe("shutting_down");
    }
    const retry = await manager.retryStage("missing", "s");
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.status).toBe(503);
      expect(retry.code).toBe("shutting_down");
    }
    await store.close();
  });

  it("repeat beginDrain joins the same promise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-join-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    const server = await listen();
    servers.push(server);
    const controller = new ShutdownController({
      server,
      manager,
      store,
      graceMs: 300,
      installSignals: false,
    });
    controllers.push(controller);
    const a = controller.beginDrain();
    const b = controller.beginDrain();
    expect(a).toBe(b);
    await expect(a).resolves.toMatchObject({ exitCode: HOST_EXIT.CLEAN });
  });

  it("store.close failure exits 5", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-store-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const closeSpy = vi
      .spyOn(store, "close")
      .mockRejectedValueOnce(new Error("checkpoint failed"));
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    const server = await listen();
    servers.push(server);
    const controller = new ShutdownController({
      server,
      manager,
      store,
      graceMs: 300,
      installSignals: false,
    });
    controllers.push(controller);

    const outcome = await controller.beginDrain();
    expect(outcome.exitCode).toBe(HOST_EXIT.FORCED);
    expect(outcome.forced).toBe(true);
    expect(outcome.escalated).toBe(false);

    closeSpy.mockRestore();
    await store.close();
  });

  it("second signal during drain exits 6", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-esc-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      executionMode: "inprocess",
    });
    const originalDrain = manager.drainActiveStages.bind(manager);
    vi.spyOn(manager, "drainActiveStages").mockImplementation(async (opts) => {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (opts.isEscalated?.()) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 2000);
      });
      return originalDrain(opts);
    });

    const server = await listen();
    servers.push(server);
    const controller = new ShutdownController({
      server,
      manager,
      store,
      graceMs: 3000,
      installSignals: false,
    });
    controllers.push(controller);

    const drain = controller.beginDrain();
    await new Promise((r) => setTimeout(r, 50));
    controller.notifySignal();
    const outcome = await drain;
    expect(outcome.exitCode).toBe(HOST_EXIT.ESCALATED);
    expect(outcome.escalated).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "ShutdownController with process workers",
  () => {
    it("SIGTERM-ignoring worker forces exit 5 and marks host_shutdown", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-force-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const run = await store.createRun({
        pipelineId: "p",
        taskYaml: "id: t\ngoal: g\n",
        taskId: "t",
      });
      await store.appendStageEvent(run.runId, "wedged", { event: "started" });
      await store.createStageExecution(run.runId, "wedged");

      const launcher = new StageProcessLauncher({
        cliEntry: mockWorker,
        env: {
          MOCK_IGNORE_SIGTERM: "1",
          MOCK_DELAY: "60000",
        },
      });
      const manager = new RunManager({
        agent: scriptedFakeAgent([]),
        store,
        cwd: root,
        projectRoot: root,
        executionMode: "process",
        stageProcessLauncher: launcher,
      });

      const launchPromise = launcher.launch({
        runId: run.runId,
        stageId: "wedged",
        rootDir: root,
      });
      await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
        timeout: 2000,
      });

      const server = await listen();
      const controller = new ShutdownController({
        server,
        manager,
        store,
        graceMs: 2500,
        installSignals: false,
      });

      const started = Date.now();
      const outcome = await controller.beginDrain();
      expect(outcome.exitCode).toBe(HOST_EXIT.FORCED);
      expect(outcome.forced).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000);

      await launchPromise.catch(() => undefined);

      const reopened = createRunStore({ rootDir: root, kind: "sqlite" });
      try {
        const detail = await reopened.readRun(run.runId);
        const stage = detail.stages.find((s) => s.stage_id === "wedged");
        expect(stage?.status).toBe("interrupted");
        const events = await reopened.listStageEvents(run.runId, "wedged");
        expect(
          events.some(
            (e) =>
              e.event === "interrupted" &&
              (e as { reason?: string }).reason === "host_shutdown",
          ),
        ).toBe(true);
      } finally {
        await reopened.close();
      }
    });

    it("cooperative SIGTERM marks host_shutdown interrupted (not failed)", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-shutdown-coop-"));
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      const run = await store.createRun({
        pipelineId: "p",
        taskYaml: "id: t\ngoal: g\n",
        taskId: "t",
      });
      await store.appendStageEvent(run.runId, "coop", { event: "started" });
      await store.createStageExecution(run.runId, "coop");
      await store.updateRunStatus(run.runId, "running");

      const launcher = new StageProcessLauncher({
        cliEntry: mockWorker,
        env: {
          MOCK_DELAY: "60000",
        },
      });
      const manager = new RunManager({
        agent: scriptedFakeAgent([]),
        store,
        cwd: root,
        projectRoot: root,
        executionMode: "process",
        stageProcessLauncher: launcher,
      });

      const launchPromise = launcher.launch({
        runId: run.runId,
        stageId: "coop",
        rootDir: root,
      });
      await vi.waitFor(() => expect(launcher.activeCount()).toBe(1), {
        timeout: 2000,
      });

      manager.stopAcceptingWork();
      const drain = await manager.drainActiveStages({
        deadlineMs: Date.now() + 3000,
      });
      expect(drain.forced).toBe(false);
      await launchPromise.catch(() => undefined);

      const detail = await store.readRun(run.runId);
      expect(detail.status).toBe("running");
      const stage = detail.stages.find((s) => s.stage_id === "coop");
      expect(stage?.status).toBe("interrupted");
      const events = await store.listStageEvents(run.runId, "coop");
      expect(
        events.some(
          (e) =>
            e.event === "interrupted" &&
            (e as { reason?: string }).reason === "host_shutdown",
        ),
      ).toBe(true);
      expect(events.some((e) => e.event === "failed")).toBe(false);
      await store.close();
    });
  },
);

describe.skipIf(process.platform === "win32")("Host SIGTERM exit codes", () => {
  it(
    "idle sf mcp SIGTERM exits 0 quickly",
    async () => {
      await withIsolatedHome(async () => {
        const probe = createServer();
        const port = await new Promise<number>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            if (address && typeof address !== "string") {
              resolve(address.port);
            } else {
              reject(new Error("failed to bind ephemeral port"));
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          probe.close((err) => (err ? reject(err) : resolve()));
        });

        const child = spawn(
          process.execPath,
          [
            tsxCli,
            cliEntry,
            "mcp",
            "--port",
            String(port),
            "--mcp-stateless",
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              STAGEFLOW_SHUTDOWN_GRACE_MS: "2000",
              STAGEFLOW_LOG_FORMAT: "json",
              STAGEFLOW_STAGE_EXECUTION: "inprocess",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        try {
          await vi.waitFor(
            () => {
              expect(stdout + stderr).toMatch(/MCP endpoint:/);
            },
            { timeout: 20000 },
          );

          const started = Date.now();
          child.kill("SIGTERM");
          const code = await new Promise<number | null>((resolve) => {
            child.on("exit", (c) => resolve(c));
          });
          expect(code).toBe(0);
          expect(Date.now() - started).toBeLessThan(3000);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      });
    },
    30_000,
  );
});
