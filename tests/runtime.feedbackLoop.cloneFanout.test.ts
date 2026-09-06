import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import {
  activeCohortFromCloneIds,
  cloneIdsFromActiveCohort,
  filterJoinInputs,
  filterJoinInstanceIds,
} from "../src/runtime/forkGeneration.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "success", summary, artifacts: [], ...extra };
}

function cloneItem(summary: string): { envelope: StageEnvelope } {
  return { envelope: okEnvelope(summary) };
}

function fanoutForks(summaries: string[]): CloneForkItem[] {
  return [
    {
      successor_id: "design-doc",
      action: "fanout",
      mode: "parallel",
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
    Array<{ type: "emit"; envelope: StageEnvelope } | { type: "never_emit" }>
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  priorEnvelopes: Map<string, StageEnvelope[] | undefined>;
  joinPriorSummaries: string[][];
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const priorEnvelopes = new Map<string, StageEnvelope[] | undefined>();
  const joinPriorSummaries: string[][] = [];

  return {
    openCounts,
    priorEnvelopes,
    joinPriorSummaries,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      priorEnvelopes.set(stageId, input.priorEnvelopes);
      if (stageId === "join-doc" && input.priorEnvelopes !== undefined) {
        joinPriorSummaries.push(
          input.priorEnvelopes.map((e) => e.summary ?? ""),
        );
      }
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      return scriptedFakeAgent([behavior]).openStage(input);
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

async function prepareCloneFeedbackRun() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fb-clone-"));
  const store = createRunStore({ rootDir: root });
  const taskYaml = await readFile(SAMPLE_TASK, "utf8");
  const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
  const loaded = await loadPipeline(pipelinePath("feedback-loop-clone-fanout"), {
    cwd: fixtures,
  });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  return {
    root,
    store,
    task,
    loaded,
    run: { runId: run.runId, workspaceDir: run.workspaceDir },
  };
}

describe("filterJoinInstanceIds", () => {
  it("returns all ids when active set is null", () => {
    expect(filterJoinInstanceIds(["a~1", "a~2"], null)).toEqual(["a~1", "a~2"]);
  });

  it("filters to the active generation only", () => {
    expect(
      filterJoinInstanceIds(["a~1", "a~2", "a~3", "a~4"], new Set(["a~3", "a~4"])),
    ).toEqual(["a~3", "a~4"]);
  });
});

describe("ActiveCohort mapping", () => {
  it("maps null/undefined to untracked", () => {
    expect(activeCohortFromCloneIds(null)).toEqual({ kind: "untracked" });
    expect(activeCohortFromCloneIds(undefined)).toEqual({ kind: "untracked" });
    expect(cloneIdsFromActiveCohort({ kind: "untracked" })).toBeNull();
  });

  it("maps empty set to awaiting_mint", () => {
    expect(activeCohortFromCloneIds(new Set())).toEqual({
      kind: "awaiting_mint",
    });
    expect(cloneIdsFromActiveCohort({ kind: "awaiting_mint" })).toEqual(
      new Set(),
    );
  });

  it("maps non-empty set to active", () => {
    const cohort = activeCohortFromCloneIds(new Set(["a~1", "a~2"]));
    expect(cohort).toEqual({
      kind: "active",
      cloneIds: new Set(["a~1", "a~2"]),
    });
    expect(cloneIdsFromActiveCohort(cohort)).toEqual(new Set(["a~1", "a~2"]));
  });
});

describe("filterJoinInputs", () => {
  it("returns all ids when untracked", () => {
    expect(
      filterJoinInputs(["a~1", "a~2"], { kind: "untracked" }),
    ).toEqual(["a~1", "a~2"]);
  });

  it("returns none when awaiting_mint", () => {
    expect(
      filterJoinInputs(["a~1", "a~2"], { kind: "awaiting_mint" }),
    ).toEqual([]);
  });

  it("filters to active cohort", () => {
    expect(
      filterJoinInputs(["a~1", "a~2", "a~3", "a~4"], {
        kind: "active",
        cloneIds: new Set(["a~3", "a~4"]),
      }),
    ).toEqual(["a~3", "a~4"]);
  });
});

describe("runtime feedback-loop clone cohort supersession", () => {
  it("supersedes old clones on send_back and mints a fresh generation on re-fanout", async () => {
    const prepared = await prepareCloneFeedbackRun();
    let submitOpenedWhileHeld = false;
    const base = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-1", {
              clone_forks: fanoutForks(["doc-a", "doc-b"]),
            }),
          },
          {
            type: "emit",
            envelope: okEnvelope("clarify-2", {
              clone_forks: fanoutForks(["doc-c", "doc-d"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("doc-a-done") }],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("doc-b-done") }],
        "design-doc~3": [{ type: "emit", envelope: okEnvelope("doc-c-done") }],
        "design-doc~4": [{ type: "emit", envelope: okEnvelope("doc-d-done") }],
        "join-doc": [
          {
            type: "emit",
            envelope: okEnvelope("send-back", {
              feedback_loop: { action: "send_back", target: "clarify" },
            }),
          },
          {
            type: "emit",
            envelope: okEnvelope("continue", {
              feedback_loop: { action: "continue" },
            }),
          },
        ],
        submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
      },
    });
    const agent: AgentPort = {
      openStage(input) {
        if (
          schedulerStageId(input) === "submit" &&
          (base.openCounts.get("join-doc") ?? 0) < 2
        ) {
          submitOpenedWhileHeld = true;
        }
        return base.openStage(input);
      },
      runStage: (input) => base.runStage(input),
    };

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(submitOpenedWhileHeld).toBe(false);

    expect(base.openCounts.get("clarify")).toBe(2);
    expect(base.openCounts.get("design-doc~1")).toBe(1);
    expect(base.openCounts.get("design-doc~2")).toBe(1);
    expect(base.openCounts.get("design-doc~3")).toBe(1);
    expect(base.openCounts.get("design-doc~4")).toBe(1);
    expect(base.openCounts.get("join-doc")).toBe(2);
    expect(base.openCounts.get("submit")).toBe(1);

    expect(base.joinPriorSummaries).toHaveLength(2);
    expect(base.joinPriorSummaries[0]!.sort()).toEqual([
      "doc-a-done",
      "doc-b-done",
    ]);
    expect(base.joinPriorSummaries[1]!.sort()).toEqual([
      "doc-c-done",
      "doc-d-done",
    ]);

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc~1")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "design-doc~2")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "design-doc~3")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "design-doc~4")?.status).toBe(
      "succeeded",
    );

    const gens = await prepared.store.listForkGenerations(prepared.run.runId, {
      forkParentStageId: "clarify",
    });
    expect(gens.length).toBeGreaterThanOrEqual(2);
    const superseded = gens.filter((g) => g.status === "superseded");
    const active = gens.filter((g) => g.status === "active");
    expect(superseded.length).toBeGreaterThanOrEqual(1);
    expect(active).toHaveLength(1);
    expect(superseded[0]!.clone_stage_ids.sort()).toEqual([
      "design-doc~1",
      "design-doc~2",
    ]);
    expect(active[0]!.clone_stage_ids.sort()).toEqual([
      "design-doc~3",
      "design-doc~4",
    ]);
    expect(active[0]!.replay_id).toBeDefined();

    const history = detail.feedback_loops![0]!;
    expect(history.loop.state).toBe("continued");
    expect(history.replays).toHaveLength(1);
  });
});
