import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { runDisplayStatus } from "../status/runStatus";
import {
  runStatusPillLabel,
  signalLabel,
  statusSignalFromReadiness,
  statusSignalFromRun,
  statusSignalFromRunStatus,
  statusSignalFromStageStatus,
} from "./statusSignal";

function summary(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id">,
): RunSummary {
  return {
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

describe("statusSignalFromRunStatus", () => {
  it("maps run display statuses", () => {
    expect(statusSignalFromRunStatus("waiting_for_input")).toBe("needs");
    expect(statusSignalFromRunStatus("running")).toBe("running");
    expect(statusSignalFromRunStatus("succeeded")).toBe("ok");
    expect(statusSignalFromRunStatus("failed")).toBe("fail");
    expect(statusSignalFromRunStatus("cancelled")).toBe("skipped");
    expect(statusSignalFromRunStatus("created")).toBe("queued");
    expect(statusSignalFromRunStatus("queued")).toBe("queued");
  });
});

describe("runStatusPillLabel", () => {
  it("uses Cancelled for operator-stopped runs", () => {
    expect(runStatusPillLabel("cancelled")).toBe("Cancelled");
    expect(statusSignalFromRunStatus("cancelled")).toBe("skipped");
    expect(signalLabel(statusSignalFromRunStatus("cancelled"))).toBe("Skipped");
  });
});

describe("statusSignalFromStageStatus", () => {
  it("maps stage statuses per pro.gud", () => {
    expect(statusSignalFromStageStatus("waiting_for_input")).toBe("needs");
    expect(statusSignalFromStageStatus("interrupted")).toBe("fail");
    expect(statusSignalFromStageStatus("running")).toBe("running");
    expect(statusSignalFromStageStatus("succeeded")).toBe("ok");
    expect(statusSignalFromStageStatus("failed")).toBe("fail");
    expect(statusSignalFromStageStatus("skipped")).toBe("skipped");
    expect(statusSignalFromStageStatus("pending")).toBe("queued");
  });
});

describe("statusSignalFromReadiness", () => {
  it("maps waiting readiness to needs always", () => {
    expect(statusSignalFromReadiness("waiting")).toBe("needs");
    expect(statusSignalFromReadiness("blocked")).toBe("queued");
    expect(statusSignalFromReadiness("ready")).toBe("queued");
    expect(statusSignalFromReadiness("interrupted")).toBe("fail");
    expect(statusSignalFromReadiness("running")).toBe("running");
    expect(statusSignalFromReadiness("succeeded")).toBe("ok");
    expect(statusSignalFromReadiness("failed")).toBe("fail");
    expect(statusSignalFromReadiness("skipped")).toBe("skipped");
  });
});

describe("statusSignalFromRun", () => {
  it("uses runDisplayStatus", () => {
    const run = summary({
      run_id: "r1",
      status: "running",
      waiting_stage_id: "gate",
    });
    expect(runDisplayStatus(run)).toBe("waiting_for_input");
    expect(statusSignalFromRun(run)).toBe("needs");
  });

  it("maps cancelled runs to skipped", () => {
    const run = summary({ run_id: "r2", status: "cancelled" });
    expect(statusSignalFromRun(run)).toBe("skipped");
    expect(runStatusPillLabel(runDisplayStatus(run))).toBe("Cancelled");
  });
});

describe("signalLabel", () => {
  it("uses pill copy", () => {
    expect(signalLabel("needs")).toBe("Needs you");
    expect(signalLabel("running")).toBe("Running");
    expect(signalLabel("ok")).toBe("Succeeded");
    expect(signalLabel("fail")).toBe("Failed");
    expect(signalLabel("queued")).toBe("Queued");
    expect(signalLabel("skipped")).toBe("Skipped");
  });
});
