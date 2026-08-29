/**
 * Nested clone-choice coverage (S6 / R10 / F7 / AE7).
 *
 * v1 does not support two clones of the same parent both fanning out the same
 * clonable successor (L3 `{catalogId}~{n}` collision). Dual-parent nested
 * fan-out is fail-closed at S4 apply. Nested proving path: a run-once B
 * (or A emitting once) fans out clonable C. Do not mint `id~1~2`.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  ...extra,
});

const cloneItem = (summary: string): { envelope: StageEnvelope } => ({
  envelope: okEnvelope(summary),
});

function onceForks(successorId: string, summary: string): CloneForkItem[] {
  return [
    {
      successor_id: successorId,
      action: "once",
      envelope: okEnvelope(summary),
    },
  ];
}

function fanoutForks(
  successorId: string,
  mode: "parallel" | "sequential",
  summaries: string[],
): CloneForkItem[] {
  return [
    {
      successor_id: successorId,
      action: "fanout",
      mode,
      clones: summaries.map(cloneItem),
    },
  ];
}

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function instanceKeyedAgent(options: {
  behaviorsByStage: Record<
    string,
    Array<
      | { type: "emit"; envelope: StageEnvelope }
      | { type: "throw"; message: string }
      | { type: "fail"; reason: string }
    >
  >;
}): AgentPort & { openCounts: Map<string, number> } {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();

  const agent: AgentPort & { openCounts: Map<string, number> } = {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? {
        type: "throw" as const,
        message: `no behavior for ${stageId} attempt ${index + 1}`,
      };
      if (behavior.type === "throw") {
        throw new Error(behavior.message);
      }
      if (behavior.type === "fail") {
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => ({ ok: false as const, reason: behavior.reason }),
        });
      }
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => ({ ok: true as const, envelope: behavior.envelope }),
      });
    },
    async runStage(input) {
      const handle = agent.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
  return agent;
}

async function prepareInprocessPipeline(
  root: string,
  pipelineId: string,
  agent: AgentPort,
) {
  const store = createRunStore({ rootDir: root });
  const taskYaml = await readFile(SAMPLE_TASK, "utf8");
  const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
  const loaded = await loadPipeline(pipelinePath(pipelineId), { cwd: fixtures });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
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
    runId: run.runId,
  };
}

function assertNoNestedInstanceIds(stageIds: string[]): void {
  for (const id of stageIds) {
    expect(id).not.toMatch(/~.+~/);
  }
}

describe("AE7 nested gate — non-clonable collect", () => {
  it("clone instance completing toward collect succeeds without clone_forks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-nested-ae7-"));
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        "detect-changes": [
          {
            type: "emit",
            envelope: okEnvelope("detect-ok", {
              clone_forks: fanoutForks("author-diagrams", "parallel", ["d1", "d2"]),
            }),
          },
        ],
        "author-diagrams~1": [{ type: "emit", envelope: okEnvelope("ad1") }],
        "author-diagrams~2": [{ type: "emit", envelope: okEnvelope("ad2") }],
        collect: [{ type: "emit", envelope: okEnvelope("collect-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "clonable-nested-gate",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("succeeded");
    const detail = await store.readRun(runId);
    const ids = detail.stages.map((s) => s.stage_id);
    expect(ids).toContain("author-diagrams~1");
    expect(ids).toContain("author-diagrams~2");
    expect(ids).not.toContain("author-diagrams");
    assertNoNestedInstanceIds(ids);
    expect(detail.stages.find((s) => s.stage_id === "author-diagrams~1")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "collect")?.status).toBe(
      "succeeded",
    );
    expect(
      detail.stages.find((s) => s.stage_id === "author-diagrams~1")?.envelope
        ?.clone_forks,
    ).toBeUndefined();
  });

  it("extra clone_forks for non-clonable collect is ignored, not an emit error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-nested-ae7-extra-"));
    const extra: CloneForkItem[] = onceForks("collect", "should-be-ignored");
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        "detect-changes": [
          {
            type: "emit",
            envelope: okEnvelope("detect-ok", {
              clone_forks: onceForks("author-diagrams", "run-once"),
            }),
          },
        ],
        "author-diagrams": [
          {
            type: "emit",
            envelope: okEnvelope("ad-ok", { clone_forks: extra }),
          },
        ],
        collect: [{ type: "emit", envelope: okEnvelope("collect-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "clonable-nested-gate",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("succeeded");
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "author-diagrams")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "collect")?.status).toBe(
      "succeeded",
    );
  });
});

describe("AE-nested-fanout F7 — clonable successor of a clone", () => {
  it("run-once B fans out C as C~1 and C~2 with predecessor needs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-nested-f7-"));
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        A: [
          {
            type: "emit",
            envelope: okEnvelope("a-ok", {
              clone_forks: onceForks("B", "b-prior"),
            }),
          },
        ],
        B: [
          {
            type: "emit",
            envelope: okEnvelope("b-ok", {
              clone_forks: fanoutForks("C", "parallel", ["c1", "c2"]),
            }),
          },
        ],
        "C~1": [{ type: "emit", envelope: okEnvelope("c1") }],
        "C~2": [{ type: "emit", envelope: okEnvelope("c2") }],
        join: [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "clonable-nested-fanout",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("succeeded");
    const detail = await store.readRun(runId);
    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag).toBeDefined();
    const ids = dag!.stage_ids;
    expect(ids).toContain("C~1");
    expect(ids).toContain("C~2");
    expect(ids).not.toContain("C~B~1~1");
    expect(ids).not.toContain("B~1~1");
    expect(ids).not.toContain("C");
    assertNoNestedInstanceIds(ids);

    const byId = new Map(dag!.nodes.map((n) => [n.id, n]));
    expect(byId.get("C~1")?.needs).toBe("B");
    expect(byId.get("C~2")?.needs).toBe("B");
    expect(byId.get("join")?.needs).toBe("C");
    expect(detail.stages.find((s) => s.stage_id === "C~1")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "C~2")?.status).toBe(
      "succeeded",
    );
  });

  it("second B clone fanning out C fails closed (v1 unsupported dual-parent)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-nested-ktd1-"));
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        A: [
          {
            type: "emit",
            envelope: okEnvelope("a-ok", {
              clone_forks: fanoutForks("B", "sequential", ["b1", "b2"]),
            }),
          },
        ],
        "B~1": [
          {
            type: "emit",
            envelope: okEnvelope("b1-ok", {
              clone_forks: fanoutForks("C", "parallel", ["c1", "c2"]),
            }),
          },
        ],
        "B~2": [
          {
            type: "emit",
            envelope: okEnvelope("b2-ok", {
              clone_forks: fanoutForks("C", "parallel", ["c3", "c4"]),
            }),
          },
        ],
        "C~1": [{ type: "emit", envelope: okEnvelope("c1") }],
        "C~2": [{ type: "emit", envelope: okEnvelope("c2") }],
        join: [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "clonable-nested-fanout",
      agent,
    );
    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("failed");
    const dag = (await store.readRunMeta(runId)).pipeline_dag;
    expect(dag).toBeDefined();
    const ids = dag!.stage_ids;
    expect(ids).toContain("C~1");
    expect(ids).toContain("C~2");
    expect(ids).not.toContain("C~3");
    expect(ids).not.toContain("C~B~1~1");
    assertNoNestedInstanceIds(ids);
    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "B~2")?.status).toBe(
      "failed",
    );
  });
});
