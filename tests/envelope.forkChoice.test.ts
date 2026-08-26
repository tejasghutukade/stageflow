import { describe, expect, it } from "vitest";
import {
  assertForkEnvelope,
  normalizeForkChoice,
} from "../src/envelope/forkChoice.js";
import type { ForkEmitContext } from "../src/types/forkChoice.js";
import { EnvelopeError } from "../src/types/envelope.js";

function makeForkContext(
  immediateSuccessorIds: string[],
  forkShape: ForkEmitContext["forkShape"] = null,
): ForkEmitContext {
  return { immediateSuccessorIds, forkShape };
}

describe("assertForkEnvelope", () => {
  it("F1: accepts valid single choice for immediate successor", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkEnvelope(
        { status: "success", fork_choice: ["path-a"] },
        ctx,
      ),
    ).not.toThrow();
  });

  it("F2: rejects choice with non-immediate successor ID (AE5)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: ["done"] }, ctx),
    ).toThrow(EnvelopeError);
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: ["done"] }, ctx),
    ).toThrow(/non-immediate successor/);
  });

  it("F3: rejects missing fork_choice on success (AE6)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkEnvelope({ status: "success" }, ctx),
    ).toThrow(EnvelopeError);
    expect(() =>
      assertForkEnvelope({ status: "success" }, ctx),
    ).toThrow(/fork_choice on success/);
  });

  it("F4: accepts failure status without fork_choice (R7)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() =>
      assertForkEnvelope({ status: "failure" }, ctx),
    ).not.toThrow();
  });

  it("F5: rejects empty fork_choice when forkShape is null (R6)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], null);
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(EnvelopeError);
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(/must not be empty/);
  });

  it("F6: accepts empty fork_choice when forkShape.allowNone is true (AE3)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: true,
    });
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: [] }, ctx),
    ).not.toThrow();
  });

  it("F7: rejects empty fork_choice when forkShape.allowNone is false (AE4)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "subset",
      allowNone: false,
    });
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(EnvelopeError);
    expect(() =>
      assertForkEnvelope({ status: "success", fork_choice: [] }, ctx),
    ).toThrow(/must not be empty/);
  });

  it("F8: rejects multi-choice when cardinality is one (R5)", () => {
    const ctx = makeForkContext(["path-a", "path-b"], {
      cardinality: "one",
      allowNone: false,
    });
    expect(() =>
      assertForkEnvelope(
        { status: "success", fork_choice: ["path-a", "path-b"] },
        ctx,
      ),
    ).toThrow(EnvelopeError);
    expect(() =>
      assertForkEnvelope(
        { status: "success", fork_choice: ["path-a", "path-b"] },
        ctx,
      ),
    ).toThrow(/exactly one choice/);
  });
});

describe("normalizeForkChoice", () => {
  it("N1: stored + undefined → empty Set", () => {
    expect(normalizeForkChoice(undefined, "stored")).toEqual(new Set());
  });

  it("N2: stored + [] → empty Set", () => {
    expect(normalizeForkChoice([], "stored")).toEqual(new Set());
  });

  it("N3: stored + [a,b] → Set of two IDs", () => {
    expect(normalizeForkChoice(["a", "b"], "stored")).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("N4: emit + valid choice → Set matching input", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(normalizeForkChoice(["path-a"], "emit", ctx)).toEqual(
      new Set(["path-a"]),
    );
  });

  it("N5: emit + missing on fork success → throws (same as F3)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() => normalizeForkChoice(undefined, "emit", ctx)).toThrow(
      EnvelopeError,
    );
    expect(() => normalizeForkChoice(undefined, "emit", ctx)).toThrow(
      /fork_choice on success/,
    );
  });

  it("N6: emit + illegal ID → throws (same as F2)", () => {
    const ctx = makeForkContext(["path-a", "path-b"]);
    expect(() => normalizeForkChoice(["done"], "emit", ctx)).toThrow(
      EnvelopeError,
    );
    expect(() => normalizeForkChoice(["done"], "emit", ctx)).toThrow(
      /non-immediate successor/,
    );
  });
});
