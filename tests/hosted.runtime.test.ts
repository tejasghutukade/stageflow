import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPort, StageHandle } from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  createHostedRuntime,
  HostedRuntimeError,
  type HostedRunEvent,
} from "../src/index.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";

const execFileAsync = promisify(execFile);

const PIPELINE = `id: hosted-smoke
stages:
  - id: work
    system_prompt: Do the work.
    model: test/model
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

const PARALLEL = `id: hosted-parallel
stages:
  - id: start
    entry: true
    route:
      - to: left
      - to: right
    system_prompt: Start.
    model: test/model
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
  - id: left
    route:
      - to: join
    system_prompt: Left.
    model: test/model
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
  - id: right
    route:
      - to: join
    system_prompt: Right.
    model: test/model
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
  - id: join
    system_prompt: Join.
    model: test/model
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

const TASK = `id: task
goal: finish the smoke run
`;

const SUCCESS = {
  type: "emit" as const,
  envelope: { status: "success", summary: "done", payload: {}, artifacts: [] as string[] },
};

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123";

function context() {
  return {
    externalRunId: "cloud-run-1",
    externalAttemptId: "attempt-1",
    packageRevision: "pkg-rev-1",
    attributes: { workspace_id: "ws-1" },
  };
}

class MemorySink {
  readonly events: HostedRunEvent[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  failOn?: (event: HostedRunEvent) => boolean;
  hang = false;
  transientFailures = 0;

  async onEvent(event: HostedRunEvent): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hang) await new Promise<void>(() => undefined);
      if (this.transientFailures > 0) {
        this.transientFailures -= 1;
        throw new Error(`transient ${SECRET}`);
      }
      if (this.failOn?.(event)) throw new Error("sink rejected");
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.events.push(structuredClone(event));
    } finally {
      this.inFlight -= 1;
    }
  }
}

function hangingAgent(): AgentPort & { closes: number } {
  let closes = 0;
  const agent: AgentPort & { closes: number } = {
    get closes() {
      return closes;
    },
    openStage(input) {
      let resolveNext: ((event: Awaited<ReturnType<StageHandle["next"]>>) => void) | undefined;
      const pending = new Promise<Awaited<ReturnType<StageHandle["next"]>>>((resolve) => {
        resolveNext = resolve;
      });
      let closed = false;
      return {
        stageId: input.stageId ?? input.stage.id,
        next: () => pending,
        deliverAnswer() {},
        async close() {
          closes += 1;
          if (closed) return;
          closed = true;
          resolveNext?.({
            status: "completed",
            result: { ok: false, reason: "stage handle closed" },
          });
        },
      };
    },
    async runStage() {
      throw new Error("hosted tests use openStage");
    },
  };
  return agent;
}

describe("hosted runtime", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup !== undefined) await cleanup();
    }
  });

  async function layout(pipeline = PIPELINE): Promise<{
    packageRoot: string;
    store: RunStore;
    storeCloses: { count: number };
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hosted-"));
    const packageRoot = path.join(root, "package");
    const storeRoot = path.join(root, "store");
    await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, "smoke.pipeline.yaml"), pipeline);
    const store = createRunStore({ rootDir: storeRoot });
    const storeCloses = { count: 0 };
    const originalClose = store.close.bind(store);
    store.close = async () => {
      storeCloses.count += 1;
      await originalClose();
    };
    cleanups.push(async () => {
      if (storeCloses.count === 0) await originalClose();
      await rm(root, { recursive: true, force: true });
    });
    return { packageRoot, store, storeCloses };
  }

  it("runs a repository-free package and returns a receipt", async () => {
    const { packageRoot, store, storeCloses } = await layout();
    const sink = new MemorySink();
    const runtime = createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: sink,
    });
    const result = await runtime.run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
      maxActiveStagesPerRun: 2,
    });

    expect(result.status).toBe("succeeded");
    expect(result.code).toBeUndefined();
    expect(result.runId).toEqual(expect.any(String));
    expect(result.externalRunId).toBe("cloud-run-1");
    expect(result.externalAttemptId).toBe("attempt-1");
    expect(result.workspaceDir && existsSync(result.workspaceDir)).toBe(true);
    expect(result.receipt).toMatchObject({
      coreVersion: PACKAGE_VERSION,
      eventSchemaVersion: 1,
      packageRevision: "pkg-rev-1",
      executionMode: "inline",
    });
    expect(Date.parse(result.receipt.startedAt)).not.toBeNaN();
    expect(Date.parse(result.receipt.finishedAt)).not.toBeNaN();
    expect(sink.events.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "stage.started",
      "stage.activity",
      "stage.activity",
      "stage.activity",
      "stage.activity",
      "stage.activity",
      "stage.succeeded",
      "run.succeeded",
    ]);
    expect(sink.events.every((event) => event.externalRunId === "cloud-run-1")).toBe(true);
    expect(sink.events.every((event) => event.externalAttemptId === "attempt-1")).toBe(true);
    expect(sink.events.every((event) => event.packageRevision === "pkg-rev-1")).toBe(true);
    expect(sink.events.every((event) => event.attributes?.workspace_id === "ws-1")).toBe(true);
    expect(sink.events.map((event) => event.sequence)).toEqual(
      sink.events.map((_, index) => index + 1),
    );
    expect(storeCloses.count).toBe(0);
  });

  it("ignores STAGEFLOW_STAGE_EXECUTION and stays inline", async () => {
    const { packageRoot, store } = await layout();
    const previousVitest = process.env.VITEST;
    const previousMode = process.env.STAGEFLOW_STAGE_EXECUTION;
    delete process.env.VITEST;
    process.env.STAGEFLOW_STAGE_EXECUTION = "process";
    try {
      const sink = new MemorySink();
      const result = await createHostedRuntime({
        agent: scriptedFakeAgent([SUCCESS]),
        localStore: store,
        eventSink: sink,
      }).run({
        packageRoot,
        pipeline: "smoke.pipeline.yaml",
        taskYaml: TASK,
        context: context(),
      });
      expect(result.status).toBe("succeeded");
      expect(result.receipt.executionMode).toBe("inline");
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousMode === undefined) delete process.env.STAGEFLOW_STAGE_EXECUTION;
      else process.env.STAGEFLOW_STAGE_EXECUTION = previousMode;
    }
  });

  it("serializes events from concurrent stages", async () => {
    const { packageRoot, store } = await layout(PARALLEL);
    const sink = new MemorySink();
    const result = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS, SUCCESS, SUCCESS, SUCCESS]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    });
    expect(result.status).toBe("succeeded");
    expect(sink.maxInFlight).toBe(1);
    const started = sink.events.filter((event) => event.type === "stage.started");
    expect(started.map((event) => ("stageId" in event ? event.stageId : ""))).toEqual(
      expect.arrayContaining(["start", "left", "right", "join"]),
    );
    expect(sink.events.map((event) => event.eventId)).toEqual(
      sink.events.map((event) => `attempt-1:${event.sequence}`),
    );
    const terminals = sink.events.filter((event) => event.type.startsWith("run.") && event.type !== "run.created" && event.type !== "run.started");
    expect(terminals).toHaveLength(1);
  });

  it("retries one delivery with the same event id", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    sink.transientFailures = 1;
    const result = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    });
    expect(result.status).toBe("succeeded");
    expect(sink.events[0]).toMatchObject({
      type: "run.created",
      eventId: "attempt-1:1",
      sequence: 1,
    });
    expect(JSON.stringify(sink.events)).not.toContain(SECRET);
  });

  it("rejects invalid task yaml before a local run exists", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    const error = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: "id: only\n",
      context: context(),
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HostedRuntimeError);
    expect(error).toMatchObject({
      code: "invalid_input",
      runId: undefined,
      localResult: undefined,
    });
    expect(sink.events).toEqual([]);
  });

  it("rejects a missing package and a stage path that escapes it", async () => {
    const { packageRoot, store } = await layout();
    const missing = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: new MemorySink(),
    }).run({
      packageRoot: path.join(packageRoot, "missing"),
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: "package_invalid", runId: undefined });

    const outside = path.join(path.dirname(packageRoot), "outside.yaml");
    await writeFile(
      outside,
      "id: work\nsystem_prompt: outside\nmodel: test/model\n",
    );
    await symlink(outside, path.join(packageRoot, "linked.yaml"));
    await writeFile(
      path.join(packageRoot, "smoke.pipeline.yaml"),
      `id: hosted-smoke
stages:
  - id: work
    uses: ./linked.yaml
`,
    );
    const escaped = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: new MemorySink(),
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(escaped).toMatchObject({ code: "package_invalid" });
  });

  it("rejects a store placed inside the package", async () => {
    const { packageRoot } = await layout();
    const store = createRunStore({ rootDir: packageRoot });
    cleanups.push(() => store.close());
    const error = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: new MemorySink(),
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_input" });
  });

  it("returns agent failure and redacts secrets", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = SECRET;
    try {
      const { packageRoot, store } = await layout();
      const sink = new MemorySink();
      const result = await createHostedRuntime({
        agent: scriptedFakeAgent([
          {
            type: "emit",
            envelope: {
              status: "success",
              summary: `leaked ${SECRET}`,
              payload: {},
              artifacts: [],
            },
          },
        ]),
        localStore: store,
        eventSink: sink,
      }).run({
        packageRoot,
        pipeline: "smoke.pipeline.yaml",
        taskYaml: TASK,
        context: context(),
      });
      expect(result.status).toBe("succeeded");
      expect(JSON.stringify(sink.events)).not.toContain(SECRET);
      expect(JSON.stringify(sink.events)).toContain("[redacted]");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("returns a typed agent failure", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    const result = await createHostedRuntime({
      agent: scriptedFakeAgent([{ type: "throw", message: "provider exploded" }]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("agent_failed");
    expect(sink.events.at(-1)?.type).toBe("run.failed");
  });

  it("fails closed when a stage asks for approval", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    const result = await createHostedRuntime({
      agent: scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [{ kind: "free_text", prompt: "approve?" }],
          envelope: { status: "success", summary: "done", payload: {}, artifacts: [] },
        },
      ]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    });
    expect(result.status).toBe("failed");
    expect(result.code).toBe("hitl_unsupported");
    expect(result.reason).toMatch(/HITL|wait/i);
    expect(result.status).not.toBe("waiting");
  });

  it("fails when the sink rejects at creation, during a stage, and at completion", async () => {
    const created = await layout();
    const creating = new MemorySink();
    creating.failOn = (event) => event.type === "run.created";
    const createdError = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: created.store,
      eventSink: creating,
      eventDeliveryTimeoutMs: 200,
    }).run({
      packageRoot: created.packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(createdError).toMatchObject({
      code: "event_sink_failed",
      eventType: "run.created",
    });
    expect(creating.events.some((event) => event.type === "run.succeeded")).toBe(false);

    const during = await layout();
    const stageSink = new MemorySink();
    stageSink.failOn = (event) => event.type === "stage.started";
    const stageError = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: during.store,
      eventSink: stageSink,
    }).run({
      packageRoot: during.packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(stageError).toBeInstanceOf(HostedRuntimeError);
    expect(stageError).toMatchObject({
      code: "event_sink_failed",
      eventType: "stage.started",
    });
    if (stageError instanceof HostedRuntimeError) {
      expect(stageError.localResult?.runId).toEqual(expect.any(String));
    }
    expect(stageSink.events.some((event) => event.type === "run.succeeded" || event.type === "run.failed")).toBe(false);

    const finished = await layout();
    const terminalSink = new MemorySink();
    terminalSink.failOn = (event) => event.type === "run.succeeded";
    const terminalError = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: finished.store,
      eventSink: terminalSink,
    }).run({
      packageRoot: finished.packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((error: unknown) => error);
    expect(terminalError).toMatchObject({ code: "event_sink_failed", eventType: "run.succeeded" });
    if (terminalError instanceof HostedRuntimeError) {
      expect(terminalError.localResult?.status).toBe("succeeded");
    }
    expect(terminalSink.events.filter((event) => event.type === "run.failed" || event.type === "run.cancelled")).toEqual([]);
  });

  it("times out a hanging sink", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    sink.hang = true;
    const error = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: sink,
      eventDeliveryTimeoutMs: 30,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "event_sink_failed" });
    if (error instanceof Error) expect(error.message).toMatch(/timed out/);
  });

  it("cancels before start and during execution", async () => {
    const before = await layout();
    const beforeSink = new MemorySink();
    const aborted = new AbortController();
    aborted.abort();
    const beforeResult = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: before.store,
      eventSink: beforeSink,
    }).run({
      packageRoot: before.packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
      signal: aborted.signal,
    });
    expect(beforeResult).toMatchObject({ status: "cancelled", code: "cancelled", runId: null });
    expect(beforeSink.events.map((event) => event.type)).toEqual(["run.cancelled"]);

    const during = await layout();
    const agent = hangingAgent();
    const duringSink = new MemorySink();
    const controller = new AbortController();
    duringSink.failOn = undefined;
    const original = duringSink.onEvent.bind(duringSink);
    duringSink.onEvent = async (event) => {
      if (event.type === "stage.started") controller.abort();
      await original(event);
    };
    const duringResult = await createHostedRuntime({
      agent,
      localStore: during.store,
      eventSink: duringSink,
    }).run({
      packageRoot: during.packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
      signal: controller.signal,
    });
    expect(duringResult.status).toBe("cancelled");
    expect(agent.closes).toBeGreaterThan(0);
    const terminals = duringSink.events.filter((event) =>
      event.type === "run.succeeded" || event.type === "run.failed" || event.type === "run.cancelled",
    );
    expect(terminals.map((event) => event.type)).toEqual(["run.cancelled"]);
  });

  it("keeps a single terminal event when cancellation races completion", async () => {
    const { packageRoot, store } = await layout();
    const sink = new MemorySink();
    const controller = new AbortController();
    const original = sink.onEvent.bind(sink);
    sink.onEvent = async (event) => {
      await original(event);
      if (event.type === "stage.succeeded") controller.abort();
    };
    const result = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
      signal: controller.signal,
    });
    const terminals = sink.events.filter((event) =>
      event.type === "run.succeeded" || event.type === "run.failed" || event.type === "run.cancelled",
    );
    expect(terminals).toHaveLength(1);
    expect(["succeeded", "cancelled"]).toContain(result.status);
    expect(result.status === "cancelled" ? terminals[0]?.type : "run.succeeded").toBe(
      result.status === "cancelled" ? "run.cancelled" : "run.succeeded",
    );
  });

  it("returns timed_out when the run exceeds timeoutMs", async () => {
    const { packageRoot, store } = await layout();
    const agent = hangingAgent();
    const sink = new MemorySink();
    const result = await createHostedRuntime({
      agent,
      localStore: store,
      eventSink: sink,
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: context(),
      timeoutMs: 40,
    });
    expect(result).toMatchObject({ status: "failed", code: "timed_out" });
    expect(agent.closes).toBeGreaterThan(0);
    expect(sink.events.filter((event) => event.type === "run.failed")).toHaveLength(1);
  });

  it("rejects credentials in correlation attributes", async () => {
    const { packageRoot, store } = await layout();
    const error = await createHostedRuntime({
      agent: scriptedFakeAgent([SUCCESS]),
      localStore: store,
      eventSink: new MemorySink(),
    }).run({
      packageRoot,
      pipeline: "smoke.pipeline.yaml",
      taskYaml: TASK,
      context: {
        ...context(),
        attributes: { token: SECRET },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_input" });
    if (error instanceof Error) expect(error.message).not.toContain(SECRET);
  });
});

describe("packed stageflow package", () => {
  it(
    "imports the hosted runtime from the package root",
    async () => {
      const repoRoot = path.resolve(import.meta.dirname, "..");
      await execFileAsync("npm", ["run", "build"], { cwd: repoRoot });
      const packDir = await mkdtemp(path.join(tmpdir(), "sf-pack-"));
      try {
        const { stdout } = await execFileAsync(
          "npm",
          ["pack", "--json", "--pack-destination", packDir],
          { cwd: repoRoot },
        );
        const packed = JSON.parse(stdout) as Array<{ filename: string }>;
        const tarball = path.join(packDir, packed[0]?.filename ?? "");
        const consumer = path.join(packDir, "consumer");
        await mkdir(consumer);
        await writeFile(
          path.join(consumer, "package.json"),
          JSON.stringify({ name: "hosted-consumer", private: true, type: "module" }),
        );
        await execFileAsync("npm", ["install", tarball], { cwd: consumer });
        const script = `
          import { createHostedRuntime, HostedRuntimeError } from "stageflow";
          if (typeof createHostedRuntime !== "function") process.exit(1);
          if (typeof HostedRuntimeError !== "function") process.exit(2);
        `;
        await execFileAsync("node", ["--input-type=module", "-e", script], {
          cwd: consumer,
        });
      } finally {
        await rm(packDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
