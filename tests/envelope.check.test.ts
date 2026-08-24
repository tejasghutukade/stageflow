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
});
