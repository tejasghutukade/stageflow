import { describe, expect, it } from "vitest";
import type { RunDetail } from "../../api";
import {
  inboundEnvelopeEmpty,
  inboundEnvelopeTitle,
  outboundEnvelopeEmpty,
  outboundEnvelopeTitle,
} from "./runEnvelopeCopy";

const run = {
  run_id: "r1",
  pipeline_id: "p",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  binding: { kind: "unbound" },
  task_yaml: "",
  stages: [
    { stage_id: "plan", status: "succeeded", events: [], artifacts: [], attempt_count: 1 },
    { stage_id: "review", status: "running", events: [], artifacts: [], attempt_count: 1 },
  ],
  pipeline_track: {
    nodes: [
      { stage_id: "plan", readiness: "succeeded", attempt_count: 1 },
      { stage_id: "review", readiness: "running", attempt_count: 1 },
    ],
    edges: [{ from: "plan", to: "review" }],
  },
  feedback_loops: [],
} as unknown as RunDetail;

describe("runEnvelopeCopy", () => {
  it("labels first-stage inbound as no predecessor", () => {
    expect(inboundEnvelopeTitle(run, undefined)).toBe("Incoming");
    expect(inboundEnvelopeEmpty(run, "plan", undefined)).toContain("first stage");
  });

  it("labels inbound from predecessor", () => {
    expect(inboundEnvelopeTitle(run, "plan")).toBe("Incoming · from plan");
    expect(inboundEnvelopeEmpty(run, "review", "plan")).toContain("from plan");
  });

  it("labels outbound to successor", () => {
    expect(outboundEnvelopeTitle(run, "review")).toBe("Outgoing · to review");
    expect(outboundEnvelopeEmpty(run, "plan", "review")).toContain("to review");
  });
});
