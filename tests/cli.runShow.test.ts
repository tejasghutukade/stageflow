import { describe, expect, it } from "vitest";
import { formatRunListLine, formatRunShow, formatWaitingEntry } from "../src/cli/runShow.js";
import { formatTriggerListLine, formatTriggerShow } from "../src/cli/triggerCommand.js";
import type { RunDetail, RunSummary, StageLogEvent, StageSnapshot } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const t0 = Date.parse("2026-11-11T02:44:38.432Z");

function stage(
  stage_id: string,
  status: StageSnapshot["status"],
  events: StageLogEvent[] = [],
  extra: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    stage_id,
    status,
    events,
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...extra,
  };
}

function envelope(summary: string): StageEnvelope {
  return {
    status: "success",
    summary,
    artifacts: [],
    payload: { secret: "do-not-print" },
  };
}

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: "2026-11-11T02-44-38-396Z-784899",
    pipeline_id: "cli-output-demo",
    task_id: "cli-output-demo",
    pipeline_path:
      "/work/pipelines/cli-output-demo.pipeline.yaml",
    project_root: "/work",
    status: "succeeded",
    created_at: new Date(t0).toISOString(),
    updated_at: new Date(t0 + 67_000).toISOString(),
    binding: { kind: "unbound" },
    task_yaml: "id: cli-output-demo\ngoal: secret goal text\n",
    stages: [],
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
    total_cost_usd: 0,
    ...overrides,
  };
}

describe("formatRunShow", () => {
  it("shows a succeeded run as a timeline with a console link", () => {
    const text = formatRunShow(
      detail({
        stages: [
          stage(
            "outline",
            "succeeded",
            [
              { event: "started", at: new Date(t0).toISOString() },
              { event: "succeeded", at: new Date(t0 + 8200).toISOString() },
            ],
            {
              envelope: envelope(
                "Three-bullet outline created on why a short walk after lunch helps a workday",
              ),
              artifacts: ["outline.txt"],
            },
          ),
          stage("polish", "succeeded", [], {
            envelope: envelope("One-line brief created from outline"),
            cost_usd: 0.125,
          }),
        ],
      }),
      { now: t0 + 67_000 },
    );
    expect(text).toContain("2026-11-11T02-44-38-396Z-784899  ● succeeded");
    expect(text).toContain("pipeline  cli-output-demo");
    expect(text).toContain("path      pipelines/cli-output-demo.pipeline.yaml");
    expect(text).toContain("task      cli-output-demo");
    expect(text).toContain("started   2026-11-11 02:44 UTC    finished 02:45 UTC    1m 7s");
    expect(text).toContain("cost      $0.0000");
    expect(text).toContain("● outline");
    expect(text).toContain("8.2s");
    expect(text).toContain("Three-bullet outline created");
    expect(text).toContain("$0.1250");
    expect(text).toContain(
      "http://127.0.0.1:3847/#/runs/2026-11-11T02-44-38-396Z-784899",
    );
    expect(text).not.toContain("do-not-print");
    expect(text).not.toContain("secret goal text");
    expect(text).not.toContain("sf runs retry");
    expect(text).not.toContain("sf runs answer");
  });

  it("keeps a failure reason and the retry command", () => {
    const text = formatRunShow(
      detail({
        status: "failed",
        failed_stage_id: "draft",
        failed_reason: "model rejected the envelope",
        binding: { kind: "repository", repository: "acme/site", ref: "main" },
        stages: [
          stage("outline", "succeeded", [], {
            envelope: envelope("wrote the outline"),
          }),
          stage("draft", "failed", [
            { event: "failed", reason: "model rejected the envelope" },
          ]),
          stage("polish", "skipped"),
        ],
      }),
    );
    expect(text).toContain("✖ failed at draft");
    expect(text).toContain("binding   acme/site @ main");
    expect(text).toContain("│  model rejected the envelope");
    expect(text).toContain("○ polish");
    expect(text).toContain("skipped");
    expect(text).toContain(
      "sf runs retry --run 2026-11-11T02-44-38-396Z-784899 --stage draft",
    );
  });

  it("names the question and the answer command when a person is waiting", () => {
    const text = formatRunShow(
      detail({
        status: "running",
        waiting_stage_id: "approve",
        total_cost_usd: 0.27,
        stages: [
          stage("draft", "succeeded", [], {
            envelope: envelope("wrote draft.md"),
          }),
          stage("approve", "waiting_for_input", [], {
            pending_prompt: {
              kind: "confirm",
              id: "q1",
              message: "Publish with the unverified statistic?",
            },
          }),
          stage("publish", "pending"),
        ],
      }),
      { now: t0 + 67_000 },
    );
    expect(text).toContain("○ waiting on approve");
    expect(text).toContain("cost      $0.2700 so far");
    expect(text).toContain("│  Publish with the unverified statistic?");
    expect(text).toContain("○ publish");
    expect(text).toContain(
      "sf runs answer --run 2026-11-11T02-44-38-396Z-784899 --stage approve",
    );
    expect(text).not.toContain("sf runs retry");
  });
});

describe("formatRunListLine", () => {
  it("keeps a list row to one line with the pipeline and the stage that needs attention", () => {
    const base = {
      run_id: "run-1",
      pipeline_id: "cli-output-demo",
      created_at: "2026-11-11T02:44:38.432Z",
      binding: { kind: "unbound" },
      stages: [],
    } as unknown as RunSummary;
    expect(formatRunListLine({ ...base, status: "succeeded" })).toContain(
      "● succeeded  2026-11-11 02:44 UTC  cli-output-demo  run-1",
    );
    expect(
      formatRunListLine({
        ...base,
        status: "failed",
        failed_stage_id: "draft",
      }),
    ).toContain("at draft");
    expect(
      formatRunListLine({
        ...base,
        status: "running",
        waiting_stage_id: "approve",
      }),
    ).toContain("○ waiting");
    expect(
      formatRunListLine({
        ...base,
        status: "running",
        waiting_stage_id: "approve",
      }),
    ).toContain("on approve");
  });
});

describe("formatWaitingEntry", () => {
  it("prints the question and the command that answers it", () => {
    const text = formatWaitingEntry({
      runId: "run-1",
      stageId: "approve",
      waiting_summary: "Publish with the unverified statistic?",
    });
    expect(text).toContain("○ run-1  approve  Publish with the unverified statistic?");
    expect(text).toContain("sf runs answer --run run-1 --stage approve");
  });

  it("points a feedback-loop gate at feedback-decide", () => {
    const text = formatWaitingEntry({
      runId: "run-1",
      stageId: "review",
      waiting_kind: "feedback_loop_decision",
      feedback_loop_id: "loop-9",
      waiting_summary: "Feedback loop limit reached — extend, continue, or abandon",
    });
    expect(text).toContain(
      "sf runs feedback-decide --run run-1 --stage review --loop loop-9 --decision extend|continue|abandon",
    );
  });
});

describe("trigger human lines", () => {
  it("lists a trigger on one line and shows the rest as fields", () => {
    const trigger = {
      id: "nightly",
      kind: "schedule" as const,
      enabled: true,
      pipeline: "blog-post",
      task: "write",
      schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
      last_run_id: "run-9",
      last_fired_at: "2026-11-11T02:44:38.432Z",
    };
    expect(formatTriggerListLine(trigger)).toBe(
      "nightly  schedule  enabled   blog-post  last run-9",
    );
    const shown = formatTriggerShow(trigger);
    expect(shown).toContain("pipeline  blog-post");
    expect(shown).toContain("schedule  0 9 * * 1-5 UTC");
    expect(shown).toContain("last run  run-9");
    expect(shown).toContain("fired     2026-11-11 02:44 UTC");
  });
});
