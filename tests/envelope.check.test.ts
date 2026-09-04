import { describe, expect, it } from "vitest";
import {
  assertRequiredEnvelope,
  isAdvancingEnvelope,
} from "../src/envelope/check.js";
import { EnvelopeError } from "../src/types/envelope.js";

describe("assertRequiredEnvelope", () => {
  it("accepts a minimal valid success envelope with one artifact path", () => {
    const envelope = assertRequiredEnvelope({
      status: "success",
      summary: "wrote design",
      artifacts: ["stages/design/attempts/1/artifacts/design.md"],
    });
    expect(envelope.status).toBe("success");
    expect(envelope.artifacts).toHaveLength(1);
  });

  it("rejects missing artifacts field or non-array artifacts; accepts empty array", () => {
    expect(() =>
      assertRequiredEnvelope({
        status: "success",
        summary: "ok",
      }),
    ).toThrow(EnvelopeError);

    expect(() =>
      assertRequiredEnvelope({
        status: "success",
        summary: "ok",
        artifacts: "nope",
      }),
    ).toThrow(EnvelopeError);

    const empty = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(empty.artifacts).toEqual([]);
  });

  it("rejects unknown status values", () => {
    expect(() =>
      assertRequiredEnvelope({
        status: "ok",
        summary: "ok",
        artifacts: [],
      }),
    ).toThrow(EnvelopeError);
  });

  it("treats status:failure as non-advancing even when fields are present", () => {
    const envelope = assertRequiredEnvelope({
      status: "failure",
      summary: "blocked",
      artifacts: [],
    });
    expect(isAdvancingEnvelope(envelope)).toBe(false);
  });

  it("accepts a legal skip clone_forks item and copies it onto the envelope", () => {
    const envelope = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
      clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
    });
    expect(envelope.clone_forks).toEqual([
      { successor_id: "author-diagrams", action: "skip" },
    ]);
  });

  it("accepts an envelope without clone_forks and leaves the field absent", () => {
    const envelope = assertRequiredEnvelope({
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    expect(envelope.clone_forks).toBeUndefined();
  });

  it("accepts explicit checklist attestations and rejects malformed ones", () => {
    const envelope = assertRequiredEnvelope({
      status: "success",
      summary: "reviewed",
      artifacts: [],
      checklist_attestations: [
        { check_id: "self-review", items: ["Tests pass", "No unrelated changes"] },
      ],
    });
    expect(envelope.checklist_attestations).toEqual([
      { check_id: "self-review", items: ["Tests pass", "No unrelated changes"] },
    ]);

    expect(() =>
      assertRequiredEnvelope({
        status: "success",
        summary: "bad",
        artifacts: [],
        checklist_attestations: [{ check_id: "self-review", items: "not-an-array" }],
      }),
    ).toThrow(/checklist_attestations/);
  });

  it("rejects clone_forks that is not an array", () => {
    expect(() =>
      assertRequiredEnvelope({
        status: "success",
        summary: "ok",
        artifacts: [],
        clone_forks: "nope",
      }),
    ).toThrow(EnvelopeError);
  });
});
