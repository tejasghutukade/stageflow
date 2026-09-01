import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { canRetry } from "../stageAction/eligibility";
import {
  abandonedDisplayCopy,
  cssStatusToken,
  isAbandonedDisplay,
  ringGlyph,
  ringStatus,
  runDisplayStatus,
  statusCopy,
  statusDotVariant,
  statusIsPulsing,
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
  "skipped",
];
const stageStatuses: StageDisplayStatus[] = [
  "pending",
  "running",
  "waiting_for_input",
  "succeeded",
  "failed",
  "skipped",
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
  it("maps every display status, with created as an unpulsed gray default", () => {
    expect(cssStatusToken("waiting_for_input")).toBe("waiting");
    expect(cssStatusToken("created")).toBeUndefined();
    expect(cssStatusToken("running")).toBe("running");
    expect(cssStatusToken("succeeded")).toBe("succeeded");
    expect(cssStatusToken("failed")).toBe("failed");
    expect(cssStatusToken("pending")).toBeUndefined();
    expect(cssStatusToken("skipped")).toBeUndefined();
  });
});

describe("statusIsPulsing", () => {
  it("is running-only, so created does not pulse", () => {
    expect(statusIsPulsing("created")).toBe(false);
    expect(statusIsPulsing("running")).toBe(true);
    expect(statusIsPulsing("waiting_for_input")).toBe(false);
  });
});

describe("statusCopy", () => {
  it("maps every display status, with waiting_for_input as waiting on you", () => {
    expect(statusCopy("waiting_for_input")).toBe("waiting on you");
    expect(statusCopy("created")).toBe("not started");
    expect(statusCopy("pending")).toBe("pending");
    expect(statusCopy("running")).toBe("running");
    expect(statusCopy("succeeded")).toBe("succeeded");
    expect(statusCopy("failed")).toBe("failed");
    expect(statusCopy("skipped")).toBe("skipped");
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

  it("locks skipped to an en dash and pending to empty", () => {
    expect(ringGlyph("skipped")).toBe("–");
    expect(ringGlyph("pending")).toBe("");
  });
});

describe("ringStatus skipped", () => {
  it("is not pending", () => {
    expect(ringStatus("skipped")).toBe("skipped");
    expect(ringStatus("skipped")).not.toBe("pending");
    expect(statusDotVariant("skipped")).toBe("neutral");
  });
});

describe("trackSegmentToken", () => {
  it("matches toSegStatus, including undefined for pending", () => {
    expect(trackSegmentToken("succeeded")).toBe("succeeded");
    expect(trackSegmentToken("running")).toBe("running");
    expect(trackSegmentToken("waiting_for_input")).toBe("waiting");
    expect(trackSegmentToken("failed")).toBe("failed");
    expect(trackSegmentToken("pending")).toBeUndefined();
    expect(trackSegmentToken("skipped")).toBe("skipped");
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

describe("isAbandonedDisplay", () => {
  it("treats the operator-abandon fail reason as abandoned", () => {
    expect(
      isAbandonedDisplay([
        { event: "started" },
        { event: "failed", reason: "process_interrupted: operator abandoned stage" },
      ]),
    ).toBe(true);
    expect(abandonedDisplayCopy()).toBe("abandoned");
    expect(canRetry("failed")).toBe(true);
  });

  it("keeps a server-restart interrupt as ordinary failed", () => {
    expect(
      isAbandonedDisplay([
        { event: "failed", reason: "process_interrupted: no active worker (server restart)" },
      ]),
    ).toBe(false);
    expect(canRetry("failed")).toBe(true);
  });

  it("treats a failed event with no reason as ordinary failed", () => {
    expect(isAbandonedDisplay([{ event: "failed" }])).toBe(false);
    expect(canRetry("failed")).toBe(true);
  });

  it("uses the last failed event, not an earlier abandon", () => {
    expect(
      isAbandonedDisplay([
        { event: "failed", reason: "process_interrupted: operator abandoned stage" },
        { event: "started" },
        { event: "failed", reason: "tool error" },
      ]),
    ).toBe(false);
  });
});
