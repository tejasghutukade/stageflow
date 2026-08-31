import { describe, expect, it } from "vitest";
import {
  projectWaitingGate,
  projectWaitingGates,
} from "../src/mcp/waitingGates.js";
import type {
  RunDetail,
  RunStore,
  RunSummary,
  StageSnapshot,
} from "../src/runstore/port.js";

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id" | "status">,
): StageSnapshot {
  return {
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "run-1",
    pipeline_id: "p",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    stages: [],
    waiting_stage_id: "clarify",
    waiting_stage_ids: ["clarify"],
    ...overrides,
  };
}

function detail(
  stages: StageSnapshot[],
  overrides: Partial<RunDetail> = {},
): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "p",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    task_yaml: "id: t\ngoal: g\n",
    stages,
    pipeline_track: { nodes: [], edges: [] },
    waiting_stage_id: "clarify",
    waiting_stage_ids: ["clarify"],
    ...overrides,
  };
}

describe("projectWaitingGate", () => {
  it("T1 free_text / confirm with pending_prompt → waiting_summary + ids + pending_prompt", () => {
    const freeText = {
      kind: "free_text" as const,
      id: "prompt-1",
      message: "What should the module name be?",
    };
    const freeItem = projectWaitingGate({
      runId: "run-1",
      stageId: "clarify",
      stage: stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: freeText,
      }),
      summary: summary(),
    });
    expect(freeItem).toEqual({
      runId: "run-1",
      stageId: "clarify",
      waiting_kind: "free_text",
      waiting_prompt_id: "prompt-1",
      pending_prompt: freeText,
      waiting_summary: "What should the module name be?",
    });

    const confirm = {
      kind: "confirm" as const,
      id: "confirm-1",
      message: "Proceed?",
    };
    const confirmItem = projectWaitingGate({
      runId: "run-1",
      stageId: "clarify",
      stage: stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: confirm,
      }),
      summary: summary(),
    });
    expect(confirmItem).toEqual({
      runId: "run-1",
      stageId: "clarify",
      waiting_kind: "confirm",
      waiting_prompt_id: "confirm-1",
      pending_prompt: confirm,
      waiting_summary: "Proceed?",
    });
  });

  it("T2 multi_question → waiting_questions from questions[].message; pending_prompt present", () => {
    const prompt = {
      kind: "multi_question" as const,
      id: "mq-1",
      questions: [
        { id: "q-module", kind: "free_text" as const, message: "Module?" },
        { id: "q-owner", kind: "free_text" as const, message: "Owner?" },
      ],
    };
    const item = projectWaitingGate({
      runId: "run-1",
      stageId: "clarify",
      stage: stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: prompt,
      }),
      summary: summary({
        waiting_questions: ["store-summary-should-not-win"],
        waiting_summary: "store summary",
      }),
    });
    expect(item).toEqual({
      runId: "run-1",
      stageId: "clarify",
      waiting_kind: "multi_question",
      waiting_prompt_id: "mq-1",
      pending_prompt: prompt,
      waiting_questions: ["Module?", "Owner?"],
    });
    expect(item).not.toHaveProperty("waiting_summary");
    expect(item.waiting_questions).toEqual(
      prompt.questions.map((q) => q.message),
    );
  });

  it("T3 artifact_backed → waiting_artifacts present", () => {
    const prompt = {
      kind: "artifact_backed" as const,
      id: "art-1",
      message: "Review artifact",
      artifacts: ["stages/clarify/attempts/1/artifacts/plan.md"],
    };
    const item = projectWaitingGate({
      runId: "run-1",
      stageId: "clarify",
      stage: stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: prompt,
      }),
      summary: summary(),
    });
    expect(item).toEqual({
      runId: "run-1",
      stageId: "clarify",
      waiting_kind: "artifact_backed",
      waiting_prompt_id: "art-1",
      pending_prompt: prompt,
      waiting_summary: "Review artifact",
      waiting_artifacts: ["stages/clarify/attempts/1/artifacts/plan.md"],
    });
  });

  it("T4 missing pending_prompt but summary waiting_* for that stage → summary fallback", () => {
    const item = projectWaitingGate({
      runId: "run-1",
      stageId: "clarify",
      stage: stage({
        stage_id: "clarify",
        status: "waiting_for_input",
      }),
      summary: summary({
        waiting_kind: "free_text",
        waiting_summary: "From summary",
        waiting_prompt_id: "sum-1",
        waiting_artifacts: ["a.md"],
        waiting_questions: ["Q1?"],
      }),
    });
    expect(item).toEqual({
      runId: "run-1",
      stageId: "clarify",
      waiting_kind: "free_text",
      waiting_summary: "From summary",
      waiting_prompt_id: "sum-1",
      waiting_artifacts: ["a.md"],
      waiting_questions: ["Q1?"],
    });
    expect(item).not.toHaveProperty("pending_prompt");
  });

  it("T4b missing pending_prompt and stage is not summary waiting_stage_id → bare ids only", () => {
    const item = projectWaitingGate({
      runId: "run-1",
      stageId: "other",
      stage: stage({
        stage_id: "other",
        status: "waiting_for_input",
      }),
      summary: summary({
        waiting_stage_id: "clarify",
        waiting_kind: "free_text",
        waiting_summary: "From summary",
      }),
    });
    expect(item).toEqual({
      runId: "run-1",
      stageId: "other",
    });
  });
});

describe("projectWaitingGates", () => {
  function fakeStore(opts: {
    summaries: RunSummary[];
    details?: Map<string, RunDetail> | ((runId: string) => RunDetail);
    failRead?: Set<string>;
  }): Pick<RunStore, "listRuns" | "readRun"> {
    return {
      async listRuns() {
        return opts.summaries;
      },
      async readRun(runId: string) {
        if (opts.failRead?.has(runId)) {
          throw new Error(`read failed: ${runId}`);
        }
        if (typeof opts.details === "function") {
          return opts.details(runId);
        }
        const d = opts.details?.get(runId);
        if (!d) throw new Error(`missing detail: ${runId}`);
        return d;
      },
    };
  }

  it("T5 stage id listed but status not waiting_for_input → omitted", async () => {
    const s = summary({
      waiting_stage_ids: ["clarify", "review"],
      waiting_stage_id: "clarify",
    });
    const store = fakeStore({
      summaries: [s],
      details: new Map([
        [
          "run-1",
          detail([
            stage({
              stage_id: "clarify",
              status: "waiting_for_input",
              pending_prompt: {
                kind: "free_text",
                id: "p1",
                message: "ok",
              },
            }),
            stage({ stage_id: "review", status: "running" }),
          ]),
        ],
      ]),
    });
    const items = await projectWaitingGates(store as RunStore);
    expect(items).toHaveLength(1);
    expect(items[0]!.stageId).toBe("clarify");
  });

  it("T6 optional runId filter: only that run’s gates", async () => {
    const promptA = {
      kind: "free_text" as const,
      id: "a",
      message: "A?",
    };
    const promptB = {
      kind: "free_text" as const,
      id: "b",
      message: "B?",
    };
    const store = fakeStore({
      summaries: [
        summary({
          run_id: "run-a",
          waiting_stage_id: "s1",
          waiting_stage_ids: ["s1"],
        }),
        summary({
          run_id: "run-b",
          waiting_stage_id: "s1",
          waiting_stage_ids: ["s1"],
        }),
      ],
      details: (runId) =>
        detail(
          [
            stage({
              stage_id: "s1",
              status: "waiting_for_input",
              pending_prompt: runId === "run-a" ? promptA : promptB,
            }),
          ],
          {
            run_id: runId,
            waiting_stage_id: "s1",
            waiting_stage_ids: ["s1"],
          },
        ),
    });

    const all = await projectWaitingGates(store as RunStore);
    expect(all.map((i) => i.runId)).toEqual(["run-a", "run-b"]);

    const filtered = await projectWaitingGates(store as RunStore, {
      runId: "run-b",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual(
      expect.objectContaining({
        runId: "run-b",
        waiting_prompt_id: "b",
        waiting_summary: "B?",
      }),
    );
  });

  it("T7 readRun failure for one summary → skip, do not fail whole list", async () => {
    const store = fakeStore({
      summaries: [
        summary({
          run_id: "bad",
          waiting_stage_id: "s1",
          waiting_stage_ids: ["s1"],
        }),
        summary({
          run_id: "good",
          waiting_stage_id: "s1",
          waiting_stage_ids: ["s1"],
        }),
      ],
      failRead: new Set(["bad"]),
      details: new Map([
        [
          "good",
          detail(
            [
              stage({
                stage_id: "s1",
                status: "waiting_for_input",
                pending_prompt: {
                  kind: "confirm",
                  id: "c1",
                  message: "ok?",
                },
              }),
            ],
            {
              run_id: "good",
              waiting_stage_id: "s1",
              waiting_stage_ids: ["s1"],
            },
          ),
        ],
      ]),
    });

    const items = await projectWaitingGates(store as RunStore);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        runId: "good",
        waiting_kind: "confirm",
        waiting_summary: "ok?",
      }),
    );
  });
});
