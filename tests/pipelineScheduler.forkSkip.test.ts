import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { hydrateScheduleFromStore } from "../src/runtime/pipelineScheduler.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(summary: string, extra?: Partial<StageEnvelope>): StageEnvelope {
  return { status: "success", summary, artifacts: [], ...extra };
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

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort {
  const stageIndex = new Map<string, number>();
  return {
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "throw" as const, message: "no behavior" };
      if (behavior.type === "throw") {
        throw new Error(behavior.message);
      }
      return {
        async next() {
          return {
            status: "completed" as const,
            result: { ok: true as const, envelope: behavior.envelope },
          };
        },
        async close() {},
      };
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

function stageEvents(detail: Awaited<ReturnType<typeof createRunStore>["readRun"]>, stageId: string) {
  return detail.stages.find((s) => s.stage_id === stageId)?.events ?? [];
}

describe("fork skip store persistence", () => {
  it("empty fork_choice persists skipped events for downstream stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-skip-empty-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("detect-ok", { fork_choice: [] }) }],
      "design-doc": [{ type: "throw", message: "should not run" }],
      "implementation-plan": [{ type: "throw", message: "should not run" }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-allow-none"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");

    expect(design?.status).toBe("skipped");
    expect(impl?.status).toBe("skipped");
    expect(stageEvents(detail, "design-doc").some((e) => e.event === "skipped")).toBe(true);
    expect(stageEvents(detail, "implementation-plan").some((e) => e.event === "skipped")).toBe(
      true,
    );
  });

  it("chosen fork path does not persist skipped event for that stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-skip-chosen-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        {
          type: "emit",
          envelope: okEnvelope("detect-ok", { fork_choice: ["design-doc"] }),
        },
      ],
      "design-doc": [{ type: "emit", envelope: okEnvelope("author-ok") }],
      "implementation-plan": [{ type: "throw", message: "should not run" }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-allow-none"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");

    expect(design?.status).toBe("succeeded");
    expect(stageEvents(detail, "design-doc").some((e) => e.event === "skipped")).toBe(false);
    expect(impl?.status).toBe("skipped");
    expect(stageEvents(detail, "implementation-plan").some((e) => e.event === "skipped")).toBe(
      true,
    );
  });

  it("hydrateScheduleFromStore restores skipped state from persisted events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fork-skip-hydrate-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("detect-ok", { fork_choice: [] }) }],
      "design-doc": [{ type: "throw", message: "should not run" }],
      "implementation-plan": [{ type: "throw", message: "should not run" }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("fork-route-allow-none"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const loaded = await loadPipeline(pipelinePath("fork-route-allow-none"), fixtures);
    const hydrated = await hydrateScheduleFromStore(
      store,
      started.runId,
      loaded.dag,
      "process",
    );

    expect(hydrated.states.get("design-doc")).toBe("skipped");
    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    expect(hydrated.states.get("clarify")).toBe("succeeded");
  });
});
