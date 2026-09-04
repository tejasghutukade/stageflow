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

  it("AE3: invented successor id is rejected when the only legal id is named", () => {
    const ctx = {
      clonableSuccessors: [{ successorId: "oss-investigate-area", cloneCap: 5 }],
    } as CloneEmitContext;
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [{ successor_id: "invented-successor", action: "skip" }],
        },
        ctx,
      ),
    ).toThrow(/extra successor_id: invented-successor/);
  });

  it("AE4: fanout assignment missing objective and paths is rejected", () => {
    const ctx = {
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 5,
          cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
        },
      ],
    } as CloneEmitContext;
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "oss-investigate-area",
              action: "fanout",
              mode: "parallel",
              clones: [
                { envelope: assignmentEnvelope({ strategy: "search broadly" }) },
                { envelope: assignmentEnvelope({ strategy: "narrow the files" }) },
              ],
            },
          ],
        },
        ctx,
      ),
    ).toThrow(/clone_input_schema|objective|paths/);
  });

  it("AE4: assignment without child output fields is accepted", () => {
    const ctx = {
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 5,
          cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
        },
      ],
    } as CloneEmitContext;
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "oss-investigate-area",
              action: "fanout",
              mode: "parallel",
              clones: [
                { envelope: assignmentEnvelope(LEGAL_AREA_ASSIGNMENT) },
                {
                  envelope: assignmentEnvelope({
                    ...LEGAL_AREA_ASSIGNMENT,
                    area_id: "auth",
                  }),
                },
              ],
            },
          ],
        },
        ctx,
      ),
    ).not.toThrow();
  });

  it("rejects skip when parent allowedActions omit it", () => {
    const ctx = {
      clonableSuccessors: [{ successorId: "oss-investigate-area", cloneCap: 5 }],
      allowedActions: ["once", "fanout"],
    } as CloneEmitContext;
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [{ successor_id: "oss-investigate-area", action: "skip" }],
        },
        ctx,
      ),
    ).toThrow(/skip/);
  });

  it("omitted clone_input_schema still accepts any well-shaped clone envelope", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "once",
              envelope: assignmentEnvelope({ strategy: "anything" }),
            },
          ],
        },
        cloneCtx(),
      ),
    ).not.toThrow();
  });

  it("omitted allowedActions still accepts skip", () => {
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

  it("AE-2: once missing assignment payload is path-qualified", () => {
    const ctx = {
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 5,
          cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
        },
      ],
    } as CloneEmitContext;
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "oss-investigate-area",
              action: "once",
              envelope: innerEnvelope("full envelope without payload"),
            },
          ],
        },
        ctx,
      ),
    ).toThrow(
      /clone_forks\[0\]\.envelope: clone assignment payload is required/,
    );
  });

  it("U1: once missing nested status is path-qualified", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "once",
              envelope: { summary: "ok", artifacts: [] },
            },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(/clone_forks\[0\]\.envelope\.status/);
  });

  it("U1: fanout second clone missing status is path-qualified", () => {
    expect(() =>
      assertCloneForks(
        {
          status: "success",
          clone_forks: [
            {
              successor_id: "author-diagrams",
              action: "fanout",
              mode: "parallel",
              clones: [
                { envelope: innerEnvelope("a") },
                { envelope: { summary: "b", artifacts: [] } },
              ],
            },
          ],
        },
        cloneCtx(),
      ),
    ).toThrow(/clone_forks\[0\]\.clones\[1\]\.envelope\.status/);
  });
});

const AREA_ASSIGNMENT_SCHEMA = {
  type: "object",
  properties: {
    area_id: { type: "string" },
    objective: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
  },
  required: ["area_id", "objective", "paths"],
};

const LEGAL_AREA_ASSIGNMENT = {
  area_id: "routing",
  objective: "Find the routing bug",
  paths: ["src/routing.ts"],
};

function assignmentEnvelope(payload: Record<string, unknown>) {
  return {
    status: "success" as const,
    summary: "assign",
    artifacts: [] as string[],
    payload,
  };
}
