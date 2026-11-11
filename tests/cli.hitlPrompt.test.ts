import { describe, expect, it } from "vitest";
import { continueThroughGates } from "../src/cli/runCommand.js";
import { collectHitlAnswer, hitlArtifactPaths } from "../src/cli/hitlPrompt.js";
import type { RunDetail, StageSnapshot } from "../src/runstore/port.js";
import type { PipelineRunResult } from "../src/runtime/pipelineRunner.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";

function scripted(lines: Array<string | null>) {
  const log: string[] = [];
  return {
    log,
    io: {
      log: (line: string) => {
        log.push(line);
      },
      readLine: async () => (lines.length > 0 ? lines.shift() ?? null : null),
    },
  };
}

const confirm: AskOperatorPrompt = {
  kind: "confirm",
  id: "q1",
  message: "Publish this one-line brief?",
};

describe("collectHitlAnswer", () => {
  it("offers accept and reject for a confirm gate", async () => {
    const wrong = scripted(["maybe", "1"]);
    const accepted = await collectHitlAnswer(confirm, wrong.io);
    expect(accepted).toEqual({ promptId: "q1", kind: "confirm", decision: "accept" });
    expect(wrong.log.join("\n")).toContain("Publish this one-line brief?");
    expect(wrong.log.join("\n")).toContain("1  accept");
    expect(wrong.log.join("\n")).toContain("2  reject");
    expect(wrong.log.join("\n")).toContain("Choose 1 or 2.");

    const rejected = scripted(["reject"]);
    expect(await collectHitlAnswer(confirm, rejected.io)).toEqual({
      promptId: "q1",
      kind: "confirm",
      decision: "reject",
    });
  });

  it("reads a typed answer", async () => {
    const cap = scripted(["payments"]);
    expect(
      await collectHitlAnswer(
        { kind: "free_text", id: "name", message: "What should the module name be?" },
        cap.io,
      ),
    ).toEqual({ promptId: "name", kind: "free_text", text: "payments" });
    expect(cap.log.join("\n")).toContain("What should the module name be?");
  });

  it("prints the file path before the choice", async () => {
    const cap = scripted(["2"]);
    const answer = await collectHitlAnswer(
      {
        kind: "artifact_backed",
        id: "doc",
        message: "Review the draft",
        artifacts: ["plan.md"],
      },
      cap.io,
      {
        runDir: "/data/runs/run-1",
        stageArtifacts: ["stages/review/attempts/1/artifacts/plan.md"],
      },
    );
    expect(answer).toEqual({ promptId: "doc", kind: "artifact_backed", decision: "reject" });
    expect(cap.log.join("\n")).toContain(
      "/data/runs/run-1/stages/review/attempts/1/artifacts/plan.md",
    );
  });

  it("asks each part of a multi-question gate and stops on cancel", async () => {
    const cap = scripted(["ship it", "1"]);
    expect(
      await collectHitlAnswer(
        {
          kind: "multi_question",
          id: "batch",
          questions: [
            { kind: "free_text", id: "title", message: "Title?" },
            { kind: "confirm", id: "go", message: "Ship it?" },
          ],
        },
        cap.io,
      ),
    ).toEqual({
      promptId: "batch",
      kind: "multi_question",
      answers: {
        title: { kind: "free_text", text: "ship it" },
        go: { kind: "confirm", decision: "accept" },
      },
    });

    const cancelled = scripted(["ship it", null]);
    expect(
      await collectHitlAnswer(
        {
          kind: "multi_question",
          id: "batch",
          questions: [
            { kind: "free_text", id: "title", message: "Title?" },
            { kind: "confirm", id: "go", message: "Ship it?" },
          ],
        },
        cancelled.io,
      ),
    ).toBeNull();
  });

  it("redacts a secret in the question", async () => {
    const cap = scripted([null]);
    await collectHitlAnswer(
      {
        kind: "confirm",
        id: "q1",
        message: "Send sk-abcdefghijklmnopqrstuvwxyz?",
      },
      cap.io,
    );
    const text = cap.log.join("\n");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});

describe("hitlArtifactPaths", () => {
  it("keeps an absolute path", () => {
    expect(hitlArtifactPaths(["/tmp/plan.md"], "/data/runs/run-1")).toEqual(["/tmp/plan.md"]);
  });
});

function waitingResult(): PipelineRunResult {
  return {
    ok: false,
    outcome: "waiting",
    runId: "run-1",
    runDir: "/data/runs/run-1",
    waitingStageId: "review",
    waitingSummary: "Publish this one-line brief?",
  };
}

function runDetail(status: RunDetail["status"], prompt?: AskOperatorPrompt): RunDetail {
  const stage = {
    stage_id: "review",
    status: prompt ? "waiting_for_input" : "succeeded",
    events: [],
    envelope: null,
    artifacts: ["stages/review/attempts/1/artifacts/plan.md"],
    attempt_count: 1,
    ...(prompt ? { pending_prompt: prompt } : {}),
  } as StageSnapshot;
  return {
    run_id: "run-1",
    pipeline_id: "demo",
    status,
    created_at: "2026-11-11T00:00:00.000Z",
    binding: { kind: "unbound" },
    task_yaml: "",
    stages: [stage],
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
    ...(prompt
      ? { waiting_stage_id: "review", waiting_summary: prompt.kind === "confirm" ? prompt.message : undefined }
      : {}),
  } as RunDetail;
}

describe("continueThroughGates", () => {
  it("submits the choice and waits until that gate clears", async () => {
    const reads = [
      runDetail("running", confirm),
      runDetail("running", confirm),
      runDetail("succeeded"),
    ];
    const delivered: unknown[] = [];
    const cap = scripted(["accept"]);
    const driven = await continueThroughGates(waitingResult(), {
      io: { log: cap.io.log, error: () => {} },
      readLine: cap.io.readLine,
      readRun: async () => reads.shift() ?? runDetail("succeeded"),
      deliverAnswer: async (_runId, _stageId, answer) => {
        delivered.push(answer);
        return { ok: true };
      },
      pollIntervalMs: 0,
    });
    expect(delivered).toEqual([{ promptId: "q1", kind: "confirm", decision: "accept" }]);
    expect(driven.failed).toBe(false);
    expect(driven.result.outcome).toBe("succeeded");
    expect(cap.log.join("\n")).toContain("Accepted.");
  });

  it("shows the stage resumed while the rest of the run is still going", async () => {
    const updates: RunDetail[] = [];
    let release: (value: { ok: true }) => void = () => {};
    const delivery = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    const reads = [
      runDetail("running", confirm),
      runDetail("running", confirm),
      runDetail("succeeded"),
    ];
    const cap = scripted(["1"]);
    const driven = continueThroughGates(waitingResult(), {
      io: { log: cap.io.log, error: () => {} },
      readLine: cap.io.readLine,
      readRun: async () => reads.shift() ?? runDetail("succeeded"),
      deliverAnswer: async () => delivery,
      onUpdate: (detail) => {
        updates.push(detail);
      },
      pollIntervalMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = updates[0]?.stages.find((stage) => stage.stage_id === "review");
    expect(resumed?.status).toBe("running");
    expect(resumed?.events.at(-1)).toMatchObject({ event: "message", text: "accepted" });
    expect(updates.at(-1)?.status).toBe("succeeded");
    release({ ok: true });
    const result = await driven;
    expect(result.failed).toBe(false);
    expect(result.result.outcome).toBe("succeeded");
  });

  it("leaves the run parked when the operator cancels", async () => {
    const cap = scripted([null]);
    let delivered = 0;
    const driven = await continueThroughGates(waitingResult(), {
      io: { log: cap.io.log, error: () => {} },
      readLine: cap.io.readLine,
      readRun: async () => runDetail("running", confirm),
      deliverAnswer: async () => {
        delivered += 1;
        return { ok: true };
      },
      pollIntervalMs: 0,
    });
    expect(delivered).toBe(0);
    expect(driven.failed).toBe(false);
    expect(driven.result.outcome).toBe("waiting");
    expect(cap.log.join("\n")).toContain("Cancelled.");
  });

  it("stops polling when the answer post rejects and keeps the waiting receipt", async () => {
    const errors: string[] = [];
    const cap = scripted(["accept"]);
    const driven = await continueThroughGates(waitingResult(), {
      io: {
        log: cap.io.log,
        error: (line) => {
          errors.push(line);
        },
      },
      readLine: cap.io.readLine,
      readRun: async () => runDetail("running", confirm),
      deliverAnswer: () => Promise.reject(new Error("socket hang up")),
      pollIntervalMs: 10,
    });
    expect(errors.join("\n")).toContain("socket hang up");
    expect(driven.failed).toBe(false);
    expect(driven.result.outcome).toBe("waiting");
  });

  it("stops polling when the answer is refused and repaints the parked gate", async () => {
    const errors: string[] = [];
    const updates: RunDetail[] = [];
    const cap = scripted(["accept"]);
    const driven = await continueThroughGates(waitingResult(), {
      io: {
        log: cap.io.log,
        error: (line) => {
          errors.push(line);
        },
      },
      readLine: cap.io.readLine,
      readRun: async () => runDetail("running", confirm),
      deliverAnswer: async () => ({ ok: false, reason: "rejected" }),
      onUpdate: (detail) => {
        updates.push(detail);
      },
      pollIntervalMs: 10,
    });
    expect(errors.join("\n")).toContain("rejected");
    expect(driven.failed).toBe(false);
    expect(driven.result.outcome).toBe("waiting");
    const parked = updates.at(-1)?.stages.find((stage) => stage.stage_id === "review");
    expect(parked?.status).toBe("waiting_for_input");
    expect(parked?.pending_prompt?.id).toBe("q1");
  });

  it("keeps the failed snapshot when a refused answer lands on a terminal run", async () => {
    const errors: string[] = [];
    const cap = scripted(["accept"]);
    let reads = 0;
    const driven = await continueThroughGates(waitingResult(), {
      io: {
        log: cap.io.log,
        error: (line) => {
          errors.push(line);
        },
      },
      readLine: cap.io.readLine,
      readRun: async () => {
        reads += 1;
        if (reads === 1) return runDetail("running", confirm);
        return {
          ...runDetail("failed"),
          failed_stage_id: "review",
          failed_reason: "stage boom",
        };
      },
      deliverAnswer: async () => ({ ok: false, reason: "rejected" }),
      pollIntervalMs: 10,
    });
    expect(errors.join("\n")).toContain("rejected");
    expect(driven.failed).toBe(false);
    expect(driven.result.outcome).toBe("failed");
    expect(driven.result.failedStageId).toBe("review");
  });
});
