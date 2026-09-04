import { describe, expect, it, vi } from "vitest";
import {
  createRunChangeBus,
  getRunChangeBusFromWrappedStore,
  isRunStoreWrapped,
  wrapRunStoreWithChangeBus,
} from "../src/runtime/runChangeBus.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Every RunStore method name — compile-fail if port adds a method we omit. */
const RUN_STORE_METHODS = [
  "createRun",
  "updateRunStatus",
  "readRunMeta",
  "readTaskYaml",
  "getWorkspaceDir",
  "ensureStageWorkspace",
  "ensureAttemptWorkspace",
  "createStageExecution",
  "listStageExecutions",
  "getLatestStageExecution",
  "countStageAttempts",
  "getStageExecution",
  "updateStageExecution",
  "upsertVerificationCheckResult",
  "listVerificationCheckResults",
  "writeEnvelope",
  "readEnvelope",
  "appendStageEvent",
  "listStageEvents",
  "listRuns",
  "readRun",
  "updatePipelineDag",
] as const satisfies readonly (keyof RunStore)[];

type MissingRunStoreMethods = Exclude<
  keyof RunStore,
  (typeof RUN_STORE_METHODS)[number]
>;
type AssertNoMissing = MissingRunStoreMethods extends never ? true : false;
const _assertAllRunStoreMethodsListed: AssertNoMissing = true;
void _assertAllRunStoreMethodsListed;

function missingRunStoreMethods(wrapped: object): string[] {
  return RUN_STORE_METHODS.filter(
    (name) => typeof (wrapped as Record<string, unknown>)[name] !== "function",
  );
}

describe("RunChangeBus", () => {
  it("emits status after updateRunStatus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-"));
    const bus = createRunChangeBus();
    const events: Array<{ runId: string; kind: string }> = [];
    bus.on((e) => events.push({ ...e }));
    const store = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    const { runId } = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(runId, "succeeded");
    expect(events).toEqual([
      { runId, kind: "created" },
      { runId, kind: "status" },
    ]);
  });

  it("emits waiting on waiting_for_input and resumed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-wait-"));
    const bus = createRunChangeBus();
    const kinds: string[] = [];
    bus.on((e) => kinds.push(e.kind));
    const store = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    const { runId } = await store.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.appendStageEvent(runId, "clarify", { event: "resumed" });
    await store.appendStageEvent(runId, "clarify", {
      event: "started",
    });
    expect(kinds.filter((k) => k === "waiting")).toEqual(["waiting", "waiting"]);
    expect(kinds.includes("created")).toBe(true);
  });

  it("isolates throwing listeners", () => {
    const bus = createRunChangeBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on((e) => seen.push(e.runId));
    bus.emit({ runId: "r1", kind: "status" });
    expect(seen).toEqual(["r1"]);
  });

  it("exposes every RunStore method on the wrap", () => {
    const store = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: path.join(tmpdir(), "sf-bus-complete") }),
      createRunChangeBus(),
    );
    expect(missingRunStoreMethods(store)).toEqual([]);
  });

  it("completeness check fails on incomplete hand-list", () => {
    const incompleteHandList = {
      createRun: async () => ({ runId: "r", workspaceDir: "/w" }),
      updateRunStatus: async () => {},
      appendStageEvent: async () => {},
      readRun: async () => ({}),
    };
    const missing = missingRunStoreMethods(incompleteHandList);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("listRuns");
    expect(missing).toContain("updatePipelineDag");
  });

  it("same-bus re-wrap is idempotent and does not double-emit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-nowrap-"));
    const bus = createRunChangeBus();
    const events: Array<{ runId: string; kind: string }> = [];
    bus.on((e) => events.push({ ...e }));

    const wrapped = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    expect(isRunStoreWrapped(wrapped)).toBe(true);
    expect(getRunChangeBusFromWrappedStore(wrapped)).toBe(bus);

    const rewrapped = wrapRunStoreWithChangeBus(wrapped, bus);
    expect(rewrapped).toBe(wrapped);

    const { runId } = await rewrapped.createRun({
      pipelineId: "p",
      taskYaml: "id: t\ngoal: g\n",
    });
    expect(events).toEqual([{ runId, kind: "created" }]);
  });

  it("throws when re-wrapping with a different bus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-mismatch-"));
    const busA = createRunChangeBus();
    const busB = createRunChangeBus();
    const wrapped = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      busA,
    );
    expect(() => wrapRunStoreWithChangeBus(wrapped, busB)).toThrow(
      /runChangeBus does not match the bus already bound to the provided store/,
    );
  });

  it("bootstrap refuses mismatched runChangeBus for a pre-wrapped store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-boot-mismatch-"));
    const busA = createRunChangeBus();
    const busB = createRunChangeBus();
    const wrapped = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      busA,
    );
    await expect(
      bootstrapStageflowHost({
        agent: scriptedFakeAgent([]),
        cwd: root,
        rootDir: root,
        store: wrapped,
        runChangeBus: busB,
      }),
    ).rejects.toThrow(
      /runChangeBus does not match the bus already bound to the provided store/,
    );
  });

  it("bootstrap reuses bound bus when pre-wrapped store has no runChangeBus option", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bus-boot-reuse-"));
    const bus = createRunChangeBus();
    const wrapped = wrapRunStoreWithChangeBus(
      createRunStore({ rootDir: root }),
      bus,
    );
    const boot = await bootstrapStageflowHost({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store: wrapped,
    });
    expect(boot.runChangeBus).toBe(bus);
    expect(boot.store).toBe(wrapped);
    await boot.mcpHandler.close();
  });

  it("delegates non-emit methods to the underlying store", async () => {
    const readRun = vi.fn(async () => ({ run_id: "r1" }));
    const listRuns = vi.fn(async () => []);
    const getWorkspaceDir = vi.fn(() => "/workspace");
    const underlying = {
      createRun: vi.fn(),
      updateRunStatus: vi.fn(),
      appendStageEvent: vi.fn(),
      readRunMeta: vi.fn(),
      readTaskYaml: vi.fn(),
      getWorkspaceDir,
      ensureStageWorkspace: vi.fn(),
      ensureAttemptWorkspace: vi.fn(),
      createStageExecution: vi.fn(),
      listStageExecutions: vi.fn(),
      getLatestStageExecution: vi.fn(),
      countStageAttempts: vi.fn(),
      getStageExecution: vi.fn(),
      updateStageExecution: vi.fn(),
      upsertVerificationCheckResult: vi.fn(),
      listVerificationCheckResults: vi.fn(),
      writeEnvelope: vi.fn(),
      readEnvelope: vi.fn(),
      listStageEvents: vi.fn(),
      listRuns,
      readRun,
      updatePipelineDag: vi.fn(),
    } as unknown as RunStore;

    const wrapped = wrapRunStoreWithChangeBus(
      underlying,
      createRunChangeBus(),
    );
    expect(missingRunStoreMethods(wrapped)).toEqual([]);

    await wrapped.readRun("r1");
    await wrapped.listRuns({ status: "running" });
    expect(wrapped.getWorkspaceDir("r1")).toBe("/workspace");

    expect(readRun).toHaveBeenCalledWith("r1");
    expect(listRuns).toHaveBeenCalledWith({ status: "running" });
    expect(getWorkspaceDir).toHaveBeenCalledWith("r1");
  });
});
