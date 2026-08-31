import { describe, expect, it } from "vitest";
import {
  inferRetryStageErrorCode,
  mapRetryStageFailure,
  mapStartFailure,
} from "../src/server/operatorResults.js";

describe("inferRetryStageErrorCode", () => {
  it("maps retry-in-progress reasons", () => {
    expect(
      inferRetryStageErrorCode("Retry already in progress for run r stage s"),
    ).toBe("retry_in_progress");
  });

  it("maps waiting-for-input reasons", () => {
    expect(
      inferRetryStageErrorCode(
        "Stage is waiting for input and cannot be retried",
      ),
    ).toBe("hitl_not_retriable");
  });

  it("maps orchestration and run-not-failed reasons", () => {
    expect(
      inferRetryStageErrorCode("Run r already has active orchestration"),
    ).toBe("run_not_retryable");
    expect(
      inferRetryStageErrorCode("Run is not failed (status=running)"),
    ).toBe("run_not_retryable");
  });

  it("maps stage-not-failed reasons", () => {
    expect(
      inferRetryStageErrorCode("Stage is not failed (status=succeeded)"),
    ).toBe("stage_not_failed");
  });

  it("returns undefined for unknown reasons", () => {
    expect(inferRetryStageErrorCode("something else went wrong")).toBe(
      undefined,
    );
  });
});

describe("mapRetryStageFailure", () => {
  it("includes code when inferred and omits ok/status", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "Stage is waiting for input and cannot be retried",
      status: 409,
    });
    expect(mapped).toEqual({
      error: "Stage is waiting for input and cannot be retried",
      code: "hitl_not_retriable",
    });
    expect(mapped).not.toHaveProperty("ok");
    expect(mapped).not.toHaveProperty("status");
  });

  it("omits code when reason does not match", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "Run missing not found",
      status: 404,
    });
    expect(mapped).toEqual({ error: "Run missing not found" });
    expect(mapped).not.toHaveProperty("code");
    expect(mapped).not.toHaveProperty("ok");
    expect(mapped).not.toHaveProperty("status");
  });
});

describe("mapStartFailure", () => {
  it("maps error + rest without ok/status leak", () => {
    const mapped = mapStartFailure({
      ok: false,
      reason: "Capacity full: 3/3 active runs",
      status: 409,
      code: "busy_capacity",
      activeCount: 3,
      maxConcurrent: 3,
      activeRunIds: ["r1", "r2", "r3"],
    });
    expect(mapped).toEqual({
      error: "Capacity full: 3/3 active runs",
      code: "busy_capacity",
      activeCount: 3,
      maxConcurrent: 3,
      activeRunIds: ["r1", "r2", "r3"],
    });
    expect(mapped).not.toHaveProperty("ok");
    expect(mapped).not.toHaveProperty("status");
  });

  it("preserves rest when status is absent", () => {
    const mapped = mapStartFailure({
      ok: false,
      reason: "pipeline path required",
    });
    expect(mapped).toEqual({ error: "pipeline path required" });
    expect(mapped).not.toHaveProperty("ok");
    expect(mapped).not.toHaveProperty("status");
  });
});

describe("adapter packaging composition", () => {
  it("MCP embeds status onto shared retry map", () => {
    const result = {
      ok: false as const,
      reason: "Stage is not failed (status=succeeded)",
      status: 409,
    };
    const body = { ...mapRetryStageFailure(result), status: result.status };
    expect(body).toEqual({
      error: "Stage is not failed (status=succeeded)",
      code: "stage_not_failed",
      status: 409,
    });
  });

  it("HTTP keeps status off the shared retry body", () => {
    const result = {
      ok: false as const,
      reason: "Stage is not failed (status=succeeded)",
      status: 409,
    };
    const body = mapRetryStageFailure(result);
    expect(body).not.toHaveProperty("status");
    expect(result.status).toBe(409);
  });
});
