import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { canRetry } from "../stageAction/eligibility";
import {
  abandonedDisplayCopy,
  cancelledDisplayCopy,
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

const runStatuses = [
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
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

const displayPresentation: Array<{
  status: DisplayStatus;
  css: ReturnType<typeof cssStatusToken>;
  dot: ReturnType<typeof statusDotVariant>;
  pulsing: boolean;
  copy: string;
}> = [
  { status: "created", css: undefined, dot: "neutral", pulsing: false, copy: "not started" },
  { status: "queued", css: undefined, dot: "neutral", pulsing: false, copy: "queued" },
  { status: "pending", css: undefined, dot: "neutral", pulsing: false, copy: "pending" },
  { status: "running", css: "running", dot: "accent", pulsing: true, copy: "running" },
  { status: "waiting_for_input", css: "waiting", dot: "warning", pulsing: false, copy: "waiting on you" },
  { status: "interrupted", css: "waiting", dot: "warning", pulsing: false, copy: "interrupted" },
  { status: "succeeded", css: "succeeded", dot: "success", pulsing: false, copy: "succeeded" },
  { status: "failed", css: "failed", dot: "error", pulsing: false, copy: "failed" },
  { status: "cancelled", css: "failed", dot: "error", pulsing: false, copy: "cancelled" },
  { status: "skipped", css: undefined, dot: "neutral", pulsing: false, copy: "skipped" },
];

describe("display status presentation", () => {
  it.each(displayPresentation)(
    "$status -> css $css, dot $dot, pulsing $pulsing, copy $copy",
    ({ status, css, dot, pulsing, copy }) => {
      expect(cssStatusToken(status)).toBe(css);
      expect(statusDotVariant(status)).toBe(dot);
      expect(statusIsPulsing(status)).toBe(pulsing);
      expect(statusCopy(status)).toBe(copy);
    },
  );
});

describe("waitingOnYouTitle", () => {
  it("title-cases the waiting_for_input statusCopy phrase", () => {
    expect(waitingOnYouTitle()).toBe("Waiting on you");
  });
});

describe("stage status presentation", () => {
  it.each([
    { status: "pending", ring: "pending", glyph: "", seg: undefined },
    { status: "running", ring: "running", glyph: "▸", seg: "running" },
    { status: "waiting_for_input", ring: "waiting", glyph: "?", seg: "waiting" },
    { status: "interrupted", ring: "waiting", glyph: "?", seg: "waiting" },
    { status: "succeeded", ring: "succeeded", glyph: "✓", seg: "succeeded" },
    { status: "failed", ring: "failed", glyph: "✕", seg: "failed" },
    { status: "skipped", ring: "skipped", glyph: "–", seg: "skipped" },
  ] as const)(
    "$status -> ring $ring, glyph $glyph, segment $seg",
    ({ status, ring, glyph, seg }) => {
      expect(ringStatus(status)).toBe(ring);
      expect(ringGlyph(status)).toBe(glyph);
      expect(ringGlyph(ring)).toBe(glyph);
      expect(trackSegmentToken(status)).toBe(seg);
    },
  );
});

describe("cancelledDisplayCopy", () => {
  it("includes cancel_reason when present", () => {
    expect(cancelledDisplayCopy("operator stop")).toBe("cancelled: operator stop");
    expect(cancelledDisplayCopy("  ")).toBe("cancelled");
    expect(cancelledDisplayCopy()).toBe("cancelled");
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
