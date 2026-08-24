import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import {
  cssStatusToken,
  ringGlyph,
  ringStatus,
  runDisplayStatus,
  statusCopy,
  trackSegmentToken,
  waitingOnYouTitle,
  type DisplayStatus,
  type StageDisplayStatus,
} from "./runStatus";

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

const runStatuses = ["created", "running", "succeeded", "failed"] as const;
const displayStatuses: DisplayStatus[] = [
  "created",
  "pending",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
];
const stageStatuses: StageDisplayStatus[] = [
  "pending",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
];

describe("runDisplayStatus", () => {
  it("AE6: waiting_stage_id resolves to waiting_for_input regardless of status", () => {
    for (const status of runStatuses) {
      expect(
        runDisplayStatus(
          summary({
            run_id: status,
            status,
            waiting_stage_id: "clarify",
          }),
        ),
      ).toBe("waiting_for_input");
    }
  });

  it("without waiting_stage_id resolves to the run's own status", () => {
    for (const status of runStatuses) {
      expect(
        runDisplayStatus(summary({ run_id: status, status })),
      ).toBe(status);
    }
  });
});

describe("cssStatusToken", () => {
  it("maps every display status, with created and running both running", () => {
    expect(cssStatusToken("waiting_for_input")).toBe("waiting");
    expect(cssStatusToken("created")).toBe("running");
    expect(cssStatusToken("running")).toBe("running");
    expect(cssStatusToken("succeeded")).toBe("succeeded");
    expect(cssStatusToken("failed")).toBe("failed");
    expect(cssStatusToken("pending")).toBeUndefined();
  });
});

describe("statusCopy", () => {
  it("maps every display status, with waiting_for_input as waiting on you", () => {
    expect(statusCopy("waiting_for_input")).toBe("waiting on you");
    expect(statusCopy("created")).toBe("created");
    expect(statusCopy("pending")).toBe("pending");
    expect(statusCopy("running")).toBe("running");
    expect(statusCopy("succeeded")).toBe("succeeded");
    expect(statusCopy("failed")).toBe("failed");
  });
});

describe("waitingOnYouTitle", () => {
  it("title-cases the waiting_for_input statusCopy phrase", () => {
    expect(waitingOnYouTitle()).toBe("Waiting on you");
    expect(statusCopy("waiting_for_input")).toBe("waiting on you");
  });
});

describe("ringGlyph", () => {
  it("uses a question mark for a waiting stage", () => {
    expect(ringGlyph("waiting_for_input")).toBe("?");
    expect(ringGlyph("waiting")).toBe("?");
  });
});

describe("trackSegmentToken", () => {
  it("matches toSegStatus, including undefined for pending", () => {
    expect(trackSegmentToken("succeeded")).toBe("succeeded");
    expect(trackSegmentToken("running")).toBe("running");
    expect(trackSegmentToken("waiting_for_input")).toBe("waiting");
    expect(trackSegmentToken("failed")).toBe("failed");
    expect(trackSegmentToken("pending")).toBeUndefined();
  });
});

describe("stage statuses without a run-level equivalent", () => {
  it("resolve pending and waiting_for_input without a default fallthrough", () => {
    expect(ringStatus("pending")).toBe("pending");
    expect(ringStatus("waiting_for_input")).toBe("waiting");
    expect(cssStatusToken("pending")).toBeUndefined();
    expect(cssStatusToken("waiting_for_input")).toBe("waiting");
    expect(trackSegmentToken("pending")).toBeUndefined();
    expect(trackSegmentToken("waiting_for_input")).toBe("waiting");
    expect(statusCopy("pending")).toBe("pending");
    expect(statusCopy("waiting_for_input")).toBe("waiting on you");
    expect(ringGlyph("pending")).toBe("");
    expect(ringGlyph("waiting_for_input")).toBe("?");

    for (const status of stageStatuses) {
      expect(ringStatus(status)).toBeDefined();
      expect(() => ringGlyph(status)).not.toThrow();
      expect(() => trackSegmentToken(status)).not.toThrow();
    }
    for (const status of displayStatuses) {
      expect(() => cssStatusToken(status)).not.toThrow();
      expect(() => statusCopy(status)).not.toThrow();
    }
  });
});
