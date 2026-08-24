import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipeline } from "../src/runtime/pipelineRunner.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (
  summary: string,
  artifacts: string[] = [],
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts,
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

function gatedParallelAgent(options: {
  gate: Promise<void>;
  behaviorsByStage: Record<
    string,
    { summary: string; fail?: boolean; delayMs?: number }
  >;
}): AgentPort & { openCounts: Map<string, number>; concurrent: number } {
  const openCounts = new Map<string, number>();
  let concurrent = 0;
  let maxConcurrent = 0;

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    concurrent: number;
    maxConcurrent: number;
  } = {
    openCounts,
    concurrent: 0,
    maxConcurrent: 0,
    openStage(input: StageRunInput) {
      const spec = options.behaviorsByStage[input.stage.id];
      if (input.stage.id === "clarify") {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => ({
            ok: true as const,
            envelope: okEnvelope(spec?.summary ?? "root"),
          }),
        });
      }
      openCounts.set(
        input.stage.id,
        (openCounts.get(input.stage.id) ?? 0) + 1,
      );
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      agent.concurrent = concurrent;
      agent.maxConcurrent = maxConcurrent;

      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => {
          await options.gate;
          if (spec?.delayMs) {
            await new Promise((r) => setTimeout(r, spec.delayMs));
          }
          concurrent -= 1;
          agent.concurrent = concurrent;
          if (spec?.fail) {
            return { ok: false as const, reason: "branch failed" };
          }
          return {
            ok: true as const,
            envelope: okEnvelope(spec?.summary ?? "ok"),
          };
        },
      });
    },
    async runStage(input) {
      const handle = agent.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return {
          ok: false,
          reason: "unexpected wait",
        };
      }
      return event.result;
    },
  };

  return agent;
}

async function prepareProcessPipeline(
  root: string,
  pipelineId: string,
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = path.join(fixtures, "tasks", "sample.yaml");
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelineId, { cwd: fixtures });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  const agent = { openStage: vi.fn(), runStage: vi.fn() };
  return {
    prepared: {
      task,
      loaded,
      run: { runId: run.runId, workspaceDir: run.workspaceDir },
      agent,
      store,
      cwd: fixtures,
    },
    store,
  };
}

describe("parallel pipeline scheduler process mode", () => {
  it("mock launcher runs parallel siblings concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-process-"));
    const { prepared, store } = await prepareProcessPipeline(
      root,
      "parallel-after-clarify",
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;

    const launch = vi.fn(
      async ({
        runId,
        stageId,
      }: {
        runId: string;
        stageId: string;
      }) => {
        if (stageId === "design-doc" || stageId === "implementation-plan") {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await gate;
          concurrent -= 1;
        }
        await store.writeEnvelope(runId, stageId, okEnvelope(stageId));
        return { type: "succeeded" as const };
      },
    );
    const mockLauncher = { launch } as unknown as StageProcessLauncher;

    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 3,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    await waitFor(() => maxConcurrent >= 2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    release();
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "design-doc" }),
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "implementation-plan" }),
    );
    for (const [args] of launch.mock.calls) {
      expect(args).not.toHaveProperty("priorEnvelope");
    }
  });

  it("waiting stage does not block sibling scheduling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-process-"));
    const { prepared, store } = await prepareProcessPipeline(
      root,
      "parallel-after-clarify",
    );
    const launched: string[] = [];

    const launch = vi.fn(
      async ({
        runId,
        stageId,
      }: {
        runId: string;
        stageId: string;
      }) => {
        launched.push(stageId);
        if (stageId === "design-doc") {
          await store.appendStageEvent(runId, stageId, {
            event: "waiting_for_input",
          });
          return { type: "waiting" as const };
        }
        await store.writeEnvelope(runId, stageId, okEnvelope(stageId));
        return { type: "succeeded" as const };
      },
    );
    const mockLauncher = { launch } as unknown as StageProcessLauncher;

    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 3,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    await waitFor(() => launched.includes("implementation-plan"));
    const result = await runPromise;

    expect(launched).toContain("design-doc");
    expect(launched).toContain("implementation-plan");
    expect(result.ok).toBe(true);

    const detail = await store.readRun(prepared.run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("waiting_for_input");
  });
});

describe("parallel pipeline scheduler (U3–U6)", () => {
  it("AE1: fan-out runs B and C concurrently with ancestor envelope copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    const priors: Record<string, string | undefined> = {};
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = gatedParallelAgent({
      gate,
      behaviorsByStage: {
        clarify: { summary: "ancestor" },
        "design-doc": { summary: "branch-b" },
        "implementation-plan": { summary: "branch-c" },
      },
    });

    const wrapped = {
      openStage(input: StageRunInput) {
        priors[input.stage.id] = input.priorEnvelope?.summary;
        return agent.openStage(input);
      },
      runStage(input: StageRunInput) {
        return agent.runStage(input);
      },
    };

    const runPromise = runPipeline({
      agent: wrapped,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "parallel-after-clarify",
      cwd: fixtures,
    });

    await waitFor(() => agent.maxConcurrent >= 2);
    expect(agent.maxConcurrent).toBeGreaterThanOrEqual(2);
    release();
    const result = await runPromise;

    expect(result.ok).toBe(true);
    expect(priors["design-doc"]).toBe("ancestor");
    expect(priors["implementation-plan"]).toBe("ancestor");
  });

  it("AE6: sibling isolation — C prior does not include B envelope while C runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    let releaseB: () => void = () => undefined;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const priors: Record<string, string | undefined> = {};

    const agent = gatedParallelAgent({
      gate: Promise.resolve(),
      behaviorsByStage: {
        clarify: { summary: "ancestor" },
        "design-doc": { summary: "branch-b" },
        "implementation-plan": { summary: "branch-c", delayMs: 200 },
      },
    });

    const wrapped = {
      openStage(input: StageRunInput) {
        if (input.stage.id === "design-doc") {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => {
              priors[input.stage.id] = input.priorEnvelope?.summary;
              await bGate;
              return {
                ok: true as const,
                envelope: okEnvelope("branch-b"),
              };
            },
          });
        }
        if (input.stage.id === "implementation-plan") {
          priors[input.stage.id] = input.priorEnvelope?.summary;
        }
        return agent.openStage(input);
      },
      runStage(input: StageRunInput) {
        const handle = wrapped.openStage(input);
        return (async () => {
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false as const, reason: "wait" };
          }
          return event.result;
        })();
      },
    };

    const runPromise = runPipeline({
      agent: wrapped,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "parallel-after-clarify",
      cwd: fixtures,
    });

    await waitFor(async () => priors["implementation-plan"] !== undefined);
    expect(priors["implementation-plan"]).toBe("ancestor");
    expect(priors["design-doc"]).toBe("ancestor");

    releaseB();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(priors["design-doc"]).toBe("ancestor");
  });

  it("AE2: ceiling 3 with five siblings — max 3 concurrent, rest after drain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = gatedParallelAgent({
      gate,
      behaviorsByStage: {
        clarify: { summary: "root" },
        "parallel-branch-a": { summary: "a" },
        "parallel-branch-b": { summary: "b" },
        "parallel-branch-c": { summary: "c" },
        "parallel-branch-d": { summary: "d" },
        "parallel-branch-e": { summary: "e" },
      },
    });

    const runPromise = runPipeline({
      agent,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "parallel-five-fork",
      cwd: fixtures,
      maxActiveStagesPerRun: 3,
    });

    await waitFor(() => agent.maxConcurrent >= 3);
    expect(agent.maxConcurrent).toBe(3);
    expect(agent.concurrent).toBe(3);

    release();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(agent.openCounts.get("parallel-branch-a")).toBe(1);
    expect(agent.openCounts.get("parallel-branch-e")).toBe(1);
  });

  it("AE3: branch failure drains in-flight sibling; clarify artifacts remain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    let releaseC: () => void = () => undefined;
    const cGate = new Promise<void>((resolve) => {
      releaseC = resolve;
    });

    const clarifyAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: okEnvelope("ancestor", ["stages/clarify/attempts/1/artifacts/a.md"]),
      },
    ]);

    const agent = {
      openStage(input: StageRunInput) {
        if (input.stage.id === "implementation-plan") {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => {
              await cGate;
              return {
                ok: true as const,
                envelope: okEnvelope("branch-c"),
              };
            },
          });
        }
        if (input.stage.id === "design-doc") {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => ({
              ok: false as const,
              reason: "branch-b failed",
            }),
          });
        }
        return clarifyAgent.openStage(input);
      },
      async runStage(input: StageRunInput) {
        const handle = agent.openStage(input);
        const event = await handle.next();
        await handle.close();
        if (event.status === "waiting_for_input") {
          return { ok: false as const, reason: "wait" };
        }
        return event.result;
      },
    };

    const runPromise = runPipeline({
      agent,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "parallel-after-clarify",
      cwd: fixtures,
    });

    await waitFor(async () => {
      const runs = await store.listRuns();
      if (runs.length === 0) return false;
      const detail = await store.readRun(runs[0]!.run_id);
      return detail.stages.some((s) => s.stage_id === "implementation-plan");
    });

    releaseC();
    const result = await runPromise;
    expect(result.ok).toBe(false);

    const runId = result.runId;
    await expect(store.readEnvelope(runId, "clarify")).resolves.toBeDefined();
    const detail = await store.readRun(runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("failed");
    expect(
      detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("succeeded");
  });

  it("AE5: C may run while B waits; answer unblocks only B subtree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    const opened: string[] = [];
    const priors: Record<string, string | undefined> = {};

    const clarifyAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: okEnvelope("ancestor"),
      },
    ]);
    const designDocAgent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: okEnvelope("branch-b"),
      },
    ]);
    const implPlanAgent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: okEnvelope("branch-c"),
      },
    ]);

    const agent = {
      openStage(input: Parameters<typeof clarifyAgent.openStage>[0]) {
        opened.push(input.stage.id);
        priors[input.stage.id] = input.priorEnvelope?.summary;
        if (input.stage.id === "clarify") return clarifyAgent.openStage(input);
        if (input.stage.id === "design-doc") return designDocAgent.openStage(input);
        if (input.stage.id === "implementation-plan") {
          return implPlanAgent.openStage(input);
        }
        return clarifyAgent.openStage(input);
      },
      runStage(input: Parameters<typeof clarifyAgent.runStage>[0]) {
        const handle = agent.openStage(input);
        return (async () => {
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false as const, reason: "wait" };
          }
          return event.result;
        })();
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      pipeline: "parallel-hitl-fork",
      task: path.join(fixtures, "tasks", "sample.yaml"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "waiting_for_input"
      );
    });

    expect(opened).toContain("implementation-plan");
    expect(priors["implementation-plan"]).toBe("ancestor");

    const delivered = await manager.deliverAnswer(
      started.runId,
      "design-doc",
      "approved",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.status === "succeeded";
    });

    expect(priors["design-doc"]).toBe("ancestor");
    expect(priors["implementation-plan"]).toBe("ancestor");
  });

  it("halted run does not start pending stages when a slot frees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-parallel-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = gatedParallelAgent({
      gate,
      behaviorsByStage: {
        clarify: { summary: "root" },
        "parallel-branch-a": { summary: "a", fail: true },
        "parallel-branch-b": { summary: "b" },
        "parallel-branch-c": { summary: "c" },
      },
    });

    const runPromise = runPipeline({
      agent,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "parallel-five-fork",
      cwd: fixtures,
      maxActiveStagesPerRun: 2,
    });

    await waitFor(() => agent.concurrent >= 2);
    release();
    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(agent.openCounts.get("parallel-branch-d")).toBeUndefined();
    expect(agent.openCounts.get("parallel-branch-e")).toBeUndefined();
  });
});
