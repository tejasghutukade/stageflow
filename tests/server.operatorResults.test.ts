import { describe, expect, it } from "vitest";
import {
  mapRetryStageFailure,
  mapStartFailure,
  mapStoreLookupError,
} from "../src/server/operatorResults.js";

describe("mapRetryStageFailure", () => {
  it("forwards site-produced code and omits ok/status", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "Stage is waiting for input and cannot be retried",
      status: 409,
      code: "hitl_not_retriable",
    });
    expect(mapped).toEqual({
      error: "Stage is waiting for input and cannot be retried",
      code: "hitl_not_retriable",
    });
    expect(mapped).not.toHaveProperty("ok");
    expect(mapped).not.toHaveProperty("status");
  });

  it("does not alter code when message text changes", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "completely different wording for the same failure",
      status: 409,
      code: "hitl_not_retriable",
    });
    expect(mapped.code).toBe("hitl_not_retriable");
  });

  it("uses internal_error when site omitted code", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "Run missing not found",
      status: 404,
    });
    expect(mapped).toEqual({
      error: "Run missing not found",
      code: "internal_error",
    });
  });

  it("forwards busy_capacity unchanged", () => {
    const mapped = mapRetryStageFailure({
      ok: false,
      reason: "Capacity full",
      status: 409,
      code: "busy_capacity",
    });
    expect(mapped.code).toBe("busy_capacity");
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

  it("keeps busy_checkout and aborted strings unchanged", () => {
    expect(
      mapStartFailure({
        ok: false,
        reason: "checkout leased",
        code: "busy_checkout",
      }).code,
    ).toBe("busy_checkout");
    expect(
      mapStartFailure({
        ok: false,
        reason: "aborted",
        code: "aborted",
      }).code,
    ).toBe("aborted");
  });
});

describe("adapter packaging composition", () => {
  it("MCP embeds status onto shared retry map", () => {
    const result = {
      ok: false as const,
      reason: "Stage is not failed (status=succeeded)",
      status: 409,
      code: "stage_not_failed",
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
      code: "stage_not_failed",
    };
    const body = mapRetryStageFailure(result);
    expect(body).not.toHaveProperty("status");
    expect(result.status).toBe(409);
  });
});

describe("mapStoreLookupError", () => {
  it("run policy maps structured Run not found prefix to 404 + code", () => {
    expect(mapStoreLookupError(new Error("Run not found: r1"), { policy: "run" })).toEqual({
      error: "Run not found: r1",
      status: 404,
      kind: "not_found",
      code: "run_not_found",
    });
    expect(mapStoreLookupError(new Error("unknown run"), { policy: "run" })).toEqual({
      error: "unknown run",
      status: 404,
      kind: "not_found",
      code: "run_not_found",
    });
  });

  it("run policy does not regex prose for not-found", () => {
    expect(mapStoreLookupError(new Error("no such row"), { policy: "run" })).toEqual({
      error: "no such row",
      status: 500,
      kind: "error",
      code: "internal_error",
    });
  });

  it("run policy maps non-matching errors to 500", () => {
    expect(mapStoreLookupError(new Error("disk I/O failed"), { policy: "run" })).toEqual({
      error: "disk I/O failed",
      status: 500,
      kind: "error",
      code: "internal_error",
    });
  });

  it("artifact policy maps missing run/artifact to 404", () => {
    expect(
      mapStoreLookupError(new Error("Run not found: r1"), { policy: "artifact" }),
    ).toEqual({
      error: "Run not found: r1",
      status: 404,
      kind: "not_found",
      code: "artifact_not_found",
    });
    expect(
      mapStoreLookupError(new Error("Artifact not found: notes.md"), {
        policy: "artifact",
      }),
    ).toEqual({
      error: "Artifact not found: notes.md",
      status: 404,
      kind: "not_found",
      code: "artifact_not_found",
    });
  });

  it("artifact policy maps deny to kind denied with mapper status 400", () => {
    expect(
      mapStoreLookupError(new Error("Artifact path denied"), { policy: "artifact" }),
    ).toEqual({
      error: "Artifact path denied",
      status: 400,
      kind: "denied",
      code: "artifact_path_denied",
    });
  });

  it("artifact policy maps other errors to 400", () => {
    expect(
      mapStoreLookupError(new Error("Artifact is not valid UTF-8 text"), {
        policy: "artifact",
      }),
    ).toEqual({
      error: "Artifact is not valid UTF-8 text",
      status: 400,
      kind: "error",
      code: "internal_error",
    });
  });

  it("envelope policy maps Envelope not found prefix", () => {
    expect(
      mapStoreLookupError(new Error("Envelope not found: r1/s1"), {
        policy: "envelope",
      }),
    ).toEqual({
      error: "Envelope not found: r1/s1",
      status: 404,
      kind: "not_found",
      code: "envelope_not_found",
    });
    expect(
      mapStoreLookupError(new Error("missing envelope"), { policy: "envelope" }),
    ).toEqual({
      error: "missing envelope",
      status: 500,
      kind: "error",
      code: "internal_error",
    });
  });

  it("envelope policy maps non-matching errors to 500", () => {
    expect(
      mapStoreLookupError(new Error("disk I/O failed"), { policy: "envelope" }),
    ).toEqual({
      error: "disk I/O failed",
      status: 500,
      kind: "error",
      code: "internal_error",
    });
  });

  it("stringifies non-Error thrown values", () => {
    expect(mapStoreLookupError("Run not found: r1", { policy: "run" })).toEqual({
      error: "Run not found: r1",
      status: 404,
      kind: "not_found",
      code: "run_not_found",
    });
  });

  it("MCP uses mapper deny status; HTTP overrides to 403", () => {
    const mapped = mapStoreLookupError(new Error("Artifact path denied"), {
      policy: "artifact",
    });
    expect(mapped).toEqual({
      error: "Artifact path denied",
      status: 400,
      kind: "denied",
      code: "artifact_path_denied",
    });
    const httpStatus = mapped.kind === "denied" ? 403 : mapped.status;
    expect(httpStatus).toBe(403);
  });
});
