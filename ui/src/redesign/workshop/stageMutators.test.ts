import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import {
  addStage,
  deleteStage,
  renameStage,
  setStageNeeds,
  stageBodyFor,
  stagePredecessors,
} from "./stageMutators";

function body(id: string): Record<string, unknown> {
  return {
    id,
    system_prompt: `do ${id}`,
    io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
  };
}

function routed(): DraftPackagePayload {
  return {
    pipeline: {
      id: "fan",
      stages: [
        { id: "clarify", uses: "./clarify.yaml", entry: true, route: [{ to: "research" }, { to: "validation" }] },
        { id: "research", uses: "./research.yaml", route: [{ to: "synthesize" }] },
        { id: "validation", uses: "./validation.yaml", route: [{ to: "synthesize", on: ["succeeded", "failed"] }] },
        { id: "synthesize", uses: "./synthesize.yaml" },
      ],
    },
    stages: [
      { path: "./clarify.yaml", body: body("clarify") },
      { path: "./research.yaml", body: body("research") },
      { path: "./validation.yaml", body: body("validation") },
      { path: "./synthesize.yaml", body: body("synthesize") },
    ],
  };
}

function preds(draft: DraftPackagePayload): Record<string, string[]> {
  return Object.fromEntries(stagePredecessors(draft));
}

describe("stagePredecessors", () => {
  it("chains stages without needs to the previous stage", () => {
    expect(
      preds({ pipeline: { id: "p", stages: [{ id: "a" }, { id: "b" }, { id: "c" }] } }),
    ).toEqual({ a: [], b: ["a"], c: ["b"] });
  });

  it("reads needs in string, array, and object forms", () => {
    expect(
      preds({
        pipeline: {
          id: "p",
          stages: [
            { id: "a" },
            { id: "b", needs: "a" },
            { id: "c", needs: [{ id: "a" }] },
            { id: "d", needs: ["b", "c"] },
          ],
        },
      }),
    ).toEqual({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] });
  });

  it("inverts forward route entries and ignores loop entries", () => {
    const draft = routed();
    draft.pipeline.stages[3]!.route = [
      { type: "loop", to: "research", max_replays: 2, on_max_replays: "fail", replay_session: "new_session" },
    ];
    expect(preds(draft)).toEqual({
      clarify: [],
      research: ["clarify"],
      validation: ["clarify"],
      synthesize: ["research", "validation"],
    });
  });
});

describe("addStage", () => {
  it("creates the first stage as an entry with a stage file", () => {
    const { draft, stageId } = addStage({ pipeline: { id: "p", stages: [] } });
    expect(stageId).toBe("stage-1");
    expect(draft.pipeline.stages).toEqual([
      { id: "stage-1", uses: "./stages/stage-1.yaml", entry: true },
    ]);
    expect(draft.stages).toEqual([
      {
        path: "./stages/stage-1.yaml",
        body: {
          id: "stage-1",
          system_prompt: "Describe what the stage-1 stage should do.",
          io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
        },
      },
    ]);
  });

  it("picks the next free id and appends after the last stage", () => {
    const first = addStage({ pipeline: { id: "p", stages: [] } }).draft;
    const { draft, stageId } = addStage(first);
    expect(stageId).toBe("stage-2");
    expect(draft.pipeline.stages[0]).toMatchObject({ id: "stage-1", entry: true, route: [{ to: "stage-2" }] });
    expect(draft.pipeline.stages[1]).toEqual({ id: "stage-2", uses: "./stages/stage-2.yaml" });
  });

  it("mirrors the sibling stage directory and wires after the given stage", () => {
    const { draft, stageId } = addStage(routed(), { id: "audit", after: "clarify" });
    expect(stageId).toBe("audit");
    expect(draft.pipeline.stages.map((s) => s.id)).toEqual([
      "clarify",
      "audit",
      "research",
      "validation",
      "synthesize",
    ]);
    expect(draft.pipeline.stages[1]).toEqual({ id: "audit", uses: "./audit.yaml" });
    expect(draft.stages!.at(-1)!.path).toBe("./audit.yaml");
    expect(draft.pipeline.stages[0]!.route).toEqual([
      { to: "research" },
      { to: "validation" },
      { to: "audit" },
    ]);
    expect(preds(draft).audit).toEqual(["clarify"]);
    expect(preds(draft).synthesize).toEqual(["research", "validation"]);
  });

  it("suffixes a requested id that is taken", () => {
    expect(addStage(routed(), { id: "research" }).stageId).toBe("research-2");
  });

  it("materializes implicit chains into route wiring", () => {
    const { draft } = addStage(
      { pipeline: { id: "p", stages: [{ id: "a" }, { id: "b" }] } },
      { id: "c", after: "a" },
    );
    expect(draft.pipeline.stages).toEqual([
      { id: "a", entry: true, route: [{ to: "c" }, { to: "b" }] },
      { id: "c", uses: "./stages/c.yaml" },
      { id: "b" },
    ]);
  });
});

describe("deleteStage", () => {
  it("removes the ref and file and strips routes to it", () => {
    const draft = deleteStage(routed(), "validation");
    expect(draft.pipeline.stages.map((s) => s.id)).toEqual(["clarify", "research", "synthesize"]);
    expect(draft.stages!.map((f) => f.path)).toEqual([
      "./clarify.yaml",
      "./research.yaml",
      "./synthesize.yaml",
    ]);
    expect(draft.pipeline.stages[0]!.route).toEqual([{ to: "research" }]);
    expect(preds(draft).synthesize).toEqual(["research"]);
  });

  it("bridges an orphaned child to the deleted stage's parents", () => {
    const draft = deleteStage(
      { pipeline: { id: "p", stages: [{ id: "a" }, { id: "b", needs: "a" }, { id: "c", needs: ["b"] }] } },
      "b",
    );
    expect(draft.pipeline.stages).toEqual([
      { id: "a", entry: true, route: [{ to: "c" }] },
      { id: "c" },
    ]);
  });

  it("promotes children of a deleted entry to entries", () => {
    const draft = deleteStage(routed(), "clarify");
    expect(draft.pipeline.stages.find((s) => s.id === "research")).toMatchObject({ entry: true });
    expect(draft.pipeline.stages.find((s) => s.id === "validation")).toMatchObject({ entry: true });
  });
});

describe("renameStage", () => {
  it("renames the ref, uses path, file, body id, and references", () => {
    const draft = renameStage(routed(), "research", "deep-research");
    expect(draft.pipeline.stages[1]).toEqual({
      id: "deep-research",
      uses: "./deep-research.yaml",
      route: [{ to: "synthesize" }],
    });
    expect(draft.pipeline.stages[0]!.route).toEqual([{ to: "deep-research" }, { to: "validation" }]);
    const renamedBody = { ...body("research"), id: "deep-research" };
    expect(draft.stages![1]).toEqual({ path: "./deep-research.yaml", body: renamedBody });
    expect(stageBodyFor(draft, "deep-research")).toEqual(renamedBody);
  });

  it("renames needs references in every form", () => {
    const draft = renameStage(
      {
        pipeline: {
          id: "p",
          stages: [{ id: "a" }, { id: "b", needs: "a" }, { id: "c", needs: [{ id: "a" }, "b"] }],
        },
      },
      "a",
      "start",
    );
    expect(draft.pipeline.stages).toEqual([
      { id: "start" },
      { id: "b", needs: "start" },
      { id: "c", needs: [{ id: "start" }, "b"] },
    ]);
  });

  it("refuses an id that is already taken", () => {
    const draft = routed();
    expect(renameStage(draft, "research", "validation")).toBe(draft);
  });
});

describe("setStageNeeds", () => {
  it("rewrites the parents' routes and keeps route options on kept edges", () => {
    const draft = setStageNeeds(routed(), "synthesize", ["validation"]);
    expect(draft.pipeline.stages[1]).toEqual({ id: "research", uses: "./research.yaml" });
    expect(draft.pipeline.stages[2]!.route).toEqual([
      { to: "synthesize", on: ["succeeded", "failed"] },
    ]);
    expect(preds(draft).synthesize).toEqual(["validation"]);
  });

  it("marks a stage with no needs as an entry", () => {
    const draft = setStageNeeds(routed(), "validation", []);
    expect(draft.pipeline.stages[2]).toMatchObject({ entry: true });
    expect(draft.pipeline.stages[0]!.route).toEqual([{ to: "research" }]);
  });

  it("drops unknown ids, itself, and descendants that would form a cycle", () => {
    const draft = setStageNeeds(routed(), "research", ["nope", "research", "synthesize", "validation"]);
    expect(preds(draft).research).toEqual(["validation"]);
    expect(draft.pipeline.stages[2]!.route).toEqual([
      { to: "synthesize", on: ["succeeded", "failed"] },
      { to: "research" },
    ]);
  });
});
