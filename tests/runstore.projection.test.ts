import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunDetail, RunMeta, RunSummary, StageSnapshot } from "../src/runstore/port.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import { projectRunDetail, projectRunSummary } from "../src/runstore/runProjection.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function meta(extra: Partial<RunMeta> = {}): RunMeta {
  return {
    run_id: "run-1",
    pipeline_id: "docs-only",
    created_at: "2026-08-18T00:00:00.000Z",
    task_id: "t",
    updated_at: "2026-08-18T00:00:01.000Z",
    status: "succeeded",
    ...extra,
  };
}

function snap(
  stage_id: string,
  status: StageSnapshot["status"],
  extra: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    stage_id,
    status,
    events: [],
    envelope: null,
    artifacts: [],
    ...extra,
  };
}

function triage(run: RunSummary | RunDetail) {
  return {
    status: run.status,
    waiting_stage_id: run.waiting_stage_id,
    waiting_stage_ids: run.waiting_stage_ids,
    waiting_summary: run.waiting_summary,
    waiting_kind: run.waiting_kind,
    waiting_prompt_id: run.waiting_prompt_id,
    waiting_artifacts: run.waiting_artifacts,
    waiting_questions: run.waiting_questions,
    failed_stage_id: run.failed_stage_id,
    failed_reason: run.failed_reason,
  };
}

describe("run projection", () => {
  it("projects waiting_stage_ids for multiple simultaneous waiters", () => {
    const stages = [
      snap("clarify", "succeeded"),
      snap("branch-a", "waiting_for_input", {
        pending_prompt: {
          kind: "free_text",
          id: "prompt-a",
          message: "Question for branch A?",
        },
      }),
      snap("branch-b", "waiting_for_input", {
        pending_prompt: {
          kind: "free_text",
          id: "prompt-b",
          message: "Question for branch B?",
        },
      }),
    ];
    const summary = projectRunSummary(meta(), stages);
    expect(summary.waiting_stage_id).toBe("branch-a");
    expect(summary.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
    expect(summary.waiting_summary).toBe("Question for branch A?");
    expect(summary.stages).toEqual([
      { id: "clarify", status: "succeeded" },
      { id: "branch-a", status: "waiting_for_input" },
      { id: "branch-b", status: "waiting_for_input" },
    ]);
  });

  it("omits waiting_stage_ids when no stages are waiting", () => {
    const stages = [snap("clarify", "succeeded")];
    const summary = projectRunSummary(meta(), stages);
    expect(summary.waiting_stage_id).toBeUndefined();
    expect(summary.waiting_stage_ids).toBeUndefined();
  });

  it("projects free_text waiting fields and running status on summary and detail", () => {
    const stages = [
      snap("clarify", "waiting_for_input", {
        pending_prompt: {
          kind: "free_text",
          id: "prompt-1",
          message: "What should the module name be?",
        },
      }),
    ];
    const summary = projectRunSummary(meta(), stages);
    const detail = projectRunDetail(meta(), stages, "id: t\ngoal: wait\n");

    expect(summary.status).toBe("running");
    expect(detail.status).toBe("running");
    expect(summary.waiting_stage_id).toBe("clarify");
    expect(summary.waiting_stage_ids).toEqual(["clarify"]);
    expect(summary.waiting_summary).toBe("What should the module name be?");
    expect(summary.waiting_kind).toBe("free_text");
    expect(summary.waiting_prompt_id).toBe("prompt-1");
    expect(summary.stages).toEqual([{ id: "clarify", status: "waiting_for_input" }]);
    expect(triage(detail)).toEqual(triage(summary));
    expect(detail.task_yaml).toBe("id: t\ngoal: wait\n");
    expect(detail.stages).toEqual(stages);
  });

  it("projects artifact_backed waiting_artifacts on both shapes", () => {
    const stages = [
      snap("review", "waiting_for_input", {
        pending_prompt: {
          kind: "artifact_backed",
          id: "ab-1",
          message: "Accept this plan?",
          artifacts: ["stages/review/attempts/1/artifacts/plan.md"],
        },
      }),
    ];
    const summary = projectRunSummary(meta(), stages);
    const detail = projectRunDetail(meta(), stages, "id: t\ngoal: plan\n");
    expect(summary.status).toBe("running");
    expect(summary.waiting_stage_id).toBe("review");
    expect(summary.waiting_kind).toBe("artifact_backed");
    expect(summary.waiting_prompt_id).toBe("ab-1");
    expect(summary.waiting_artifacts).toEqual(["stages/review/attempts/1/artifacts/plan.md"]);
    expect(triage(detail)).toEqual(triage(summary));
  });

  it("projects multi_question waiting_questions on both shapes", () => {
    const stages = [
      snap("done", "succeeded"),
      snap("ask", "waiting_for_input", {
        pending_prompt: {
          kind: "multi_question",
          id: "mq",
          questions: [
            { kind: "free_text", id: "q1", message: "Name the module?" },
            { kind: "confirm", id: "q2", message: "Ship it?" },
          ],
        },
      }),
    ];
    const summary = projectRunSummary(meta(), stages);
    const detail = projectRunDetail(meta(), stages, "id: t\ngoal: ask\n");
    expect(summary.status).toBe("running");
    expect(summary.waiting_stage_id).toBe("ask");
    expect(summary.waiting_summary).toBe("Name the module?");
    expect(summary.waiting_kind).toBe("multi_question");
    expect(summary.waiting_prompt_id).toBe("mq");
    expect(summary.waiting_questions).toEqual(["Name the module?", "Ship it?"]);
    expect(summary.stages).toEqual([
      { id: "done", status: "succeeded" },
      { id: "ask", status: "waiting_for_input" },
    ]);
    expect(triage(detail)).toEqual(triage(summary));
  });

  it("projects first failed stage and last failed reason on both shapes", () => {
    const stages = [
      snap("clarify", "succeeded"),
      snap("verify", "failed", {
        events: [
          { event: "started" },
          { event: "failed", reason: "first" },
          { event: "failed", reason: "envelope payload failed schema" },
        ],
      }),
    ];
    const summary = projectRunSummary(meta({ status: "running" }), stages);
    const detail = projectRunDetail(meta({ status: "running" }), stages, "id: t\ngoal: fail\n");
    expect(summary.status).toBe("failed");
    expect(summary.failed_stage_id).toBe("verify");
    expect(summary.failed_reason).toBe("envelope payload failed schema");
    expect(summary.waiting_stage_id).toBeUndefined();
    expect(triage(detail)).toEqual(triage(summary));
  });

  it("uses persisted meta.status when there are no stages", () => {
    expect(projectRunSummary(meta({ status: "succeeded" }), []).status).toBe(
      "succeeded",
    );
    expect(projectRunDetail(meta({ status: "failed" }), [], "id: t\n").status).toBe(
      "failed",
    );
    expect(projectRunSummary(meta({ status: undefined }), []).status).toBe(
      "created",
    );
  });

  it("derives status from stages and ignores persisted meta.status", () => {
    const waiting = [snap("clarify", "waiting_for_input")];
    expect(projectRunSummary(meta({ status: "succeeded" }), waiting).status).toBe(
      "running",
    );
    expect(
      projectRunDetail(meta({ status: "failed" }), waiting, "id: t\n").status,
    ).toBe("running");

    const succeeded = [snap("clarify", "succeeded")];
    expect(projectRunSummary(meta({ status: "running" }), succeeded).status).toBe(
      "succeeded",
    );
  });

  it("returns identical summaries and details from the same meta and stages", () => {
    const stages = [
      snap("review", "waiting_for_input", {
        pending_prompt: {
          kind: "artifact_backed",
          id: "ab-1",
          message: "Accept this plan?",
          artifacts: ["stages/review/attempts/1/artifacts/plan.md"],
        },
      }),
    ];
    const input = meta();
    const yaml = "id: t\ngoal: same\n";
    expect(projectRunSummary(input, stages)).toEqual(
      projectRunSummary(input, stages),
    );
    expect(projectRunDetail(input, stages, yaml)).toEqual(
      projectRunDetail(input, stages, yaml),
    );
  });

  it("projects pipeline_track as linear chain during beta running", async () => {
    const loaded = await loadPipeline("docs-only", {
      cwd: fixtures,
      stagesDir: path.join(fixtures, "stages"),
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const stages = [
      snap("clarify", "succeeded"),
      snap("design-doc", "running"),
      snap("implementation-plan", "pending"),
    ];
    const detail = projectRunDetail(meta(), stages, "id: t\n", dag);
    expect(detail.stages.map((s) => s.stage_id)).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
    expect(detail.pipeline_track.nodes.map((n) => n.stage_id)).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
    expect(detail.pipeline_track.edges).toEqual([
      { from: "clarify", to: "design-doc" },
      { from: "design-doc", to: "implementation-plan" },
    ]);
    expect(
      detail.pipeline_track.nodes.find((n) => n.stage_id === "design-doc")
        ?.readiness,
    ).toBe("running");
    expect(
      detail.pipeline_track.nodes.find((n) => n.stage_id === "implementation-plan")
        ?.readiness,
    ).toBe("blocked");
  });

  it("preserves per-stage pending_prompt for multi-wait detail", () => {
    const stages = [
      snap("clarify", "succeeded"),
      snap("branch-a", "waiting_for_input", {
        pending_prompt: {
          kind: "free_text",
          id: "prompt-a",
          message: "Question for branch A?",
        },
      }),
      snap("branch-b", "waiting_for_input", {
        pending_prompt: {
          kind: "free_text",
          id: "prompt-b",
          message: "Question for branch B?",
        },
      }),
    ];
    const detail = projectRunDetail(meta(), stages, "id: t\n");
    expect(detail.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
    expect(detail.stages[1]?.pending_prompt?.message).toBe(
      "Question for branch A?",
    );
    expect(detail.stages[2]?.pending_prompt?.message).toBe(
      "Question for branch B?",
    );
    expect(detail.pipeline_track.nodes).toHaveLength(3);
  });

  it("listRuns and readRun agree on triage fields for the same events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-proj-sqlite-"));
    const store = createRunStore({ rootDir: root });

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "operator_prompt",
      prompt: {
        kind: "free_text",
        id: "prompt-1",
        message: "What should the module name be?",
      },
    });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const summary = (await store.listRuns()).find((r) => r.run_id === run.runId);
    const detail = await store.readRun(run.runId);

    expect(summary).toBeDefined();
    expect(triage(detail)).toEqual(triage(summary!));
    expect(summary?.stages).toEqual([
      { id: "clarify", status: "waiting_for_input", attempt_count: 1 },
    ]);
  });
});
