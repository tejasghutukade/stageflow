import { describe, expect, it } from "vitest";
import { assertCloneForks } from "../src/envelope/cloneForks.js";
import type { CloneEmitContext } from "../src/types/forkChoice.js";
import { EnvelopeError } from "../src/types/envelope.js";

function cloneCtx(
  clonableSuccessors: CloneEmitContext["clonableSuccessors"] = [
    { successorId: "author-diagrams", cloneCap: 5 },
  ],
): CloneEmitContext {
  return { clonableSuccessors };
}

function innerEnvelope(summary = "clone prior") {
  return { status: "success" as const, summary, artifacts: [] as string[] };
}

describe("assertCloneForks", () => {
  it("AE3: throws when success omits clone_forks", () => {
    expect(() =>
      assertCloneForks({ status: "success" }, cloneCtx()),
    ).toThrow(EnvelopeError);
  });

  it("AE3: throws when clone_forks is empty and clonable successors exist", () => {
    expect(() =>
      assertCloneForks({ status: "success", clone_forks: [] }, cloneCtx()),
    ).toThrow(EnvelopeError);
  });

  it("AE5: throws when fanout length exceeds clone_cap", () => {
    const clones = Array.from({ length: 6 }, (_, i) => ({
      envelope: innerEnvelope(`clone ${i}`),
    }));
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "parallel",
              clones,
            },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);
  });

  it("throws when fanout length is 1", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "parallel",
              clones: [{ envelope: innerEnvelope() }],
            },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);
  });

  it("accepts skip matching the clonable successor set", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [{ successor_id: "author-diagrams", action: "skip" }],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("accepts once with an envelope and no mode or clones", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "once",
              envelope: innerEnvelope(),
            },
          ],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("accepts fanout parallel N=2", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "parallel",
              clones: [{ envelope: innerEnvelope("a") }, { envelope: innerEnvelope("b") }],
            },
          ],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("accepts fanout sequential N=2", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "sequential",
              clones: [{ envelope: innerEnvelope("a") }, { envelope: innerEnvelope("b") }],
            },
          ],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("accepts fanout N equal to clone_cap", () => {
    const clones = Array.from({ length: 5 }, (_, i) => ({
      envelope: innerEnvelope(`clone ${i}`),
    }));
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "parallel",
              clones,
            },
          ],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("throws on extra successor, missing successor, and duplicate id", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            { successor_id: "author-diagrams", action: "skip" },
            { successor_id: "collect", action: "skip" },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);

    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [{ successor_id: "collect", action: "skip" }],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);

    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            { successor_id: "author-diagrams", action: "skip" },
            { successor_id: "author-diagrams", action: "once", envelope: innerEnvelope() },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);
  });

  it("throws when skip includes envelope or once omits envelope", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "skip",
              envelope: innerEnvelope(),
            },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);

    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [{ successor_id: "author-diagrams", action: "once" }],
        },
        cloneCtx(),
      ),
    ).toThrow(EnvelopeError);
  });

  it("AE-fail: does not throw on failure without clone_forks", () => {
    expect(() =>
      assertCloneForks({ status: "failure" }, cloneCtx()),
    ).not.toThrow();
  });
});
