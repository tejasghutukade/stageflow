import { describe, expect, it } from "vitest";
import {
  appendCloneInstances,
  linearCompatDagSnapshot,
} from "../src/runstore/pipelineDagSnapshot.js";
import { guardStageId } from "../src/runstore/workspaceLayout.js";
import {
  definitionIdForInstance,
  mintCloneInstanceId,
  mintCloneInstanceIds,
} from "../src/runstore/stageInstanceId.js";

describe("stage instance ids", () => {
  it("mints 1-based ids in clone-list order", () => {
    expect(mintCloneInstanceIds("author-diagrams", 3)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(mintCloneInstanceId("author-diagrams", 1)).toBe("author-diagrams~1");
  });

  it("rejects slash catalog ids and n=0", () => {
    expect(() => mintCloneInstanceId("author-diagrams/1", 1)).toThrow(/stageId/);
    expect(() => guardStageId("a/b")).toThrow(/stageId/);
    expect(() => mintCloneInstanceId("author-diagrams", 0)).toThrow();
  });

  it("definitionIdForInstance reads definition_id and does not parse tilde", () => {
    const frozen = linearCompatDagSnapshot(["detect", "author-diagrams", "collect"]);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });
    expect(definitionIdForInstance(snapshot, "author-diagrams~2")).toBe(
      "author-diagrams",
    );
    expect(definitionIdForInstance(snapshot, "detect")).toBe("detect");
    expect(definitionIdForInstance(undefined, "author-diagrams~2")).toBe(
      "author-diagrams~2",
    );
    expect(definitionIdForInstance(frozen, "author-diagrams~2")).toBe(
      "author-diagrams~2",
    );
  });
});


describe("stage instance ids", () => {
  it("mints 1-based ids in clone-list order", () => {
    expect(mintCloneInstanceIds("author-diagrams", 3)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(mintCloneInstanceId("author-diagrams", 1)).toBe("author-diagrams~1");
  });

  it("rejects slash catalog ids and n=0", () => {
    expect(() => mintCloneInstanceId("author-diagrams/1", 1)).toThrow(/stageId/);
    expect(() => guardStageId("a/b")).toThrow(/stageId/);
    expect(() => mintCloneInstanceId("author-diagrams", 0)).toThrow();
  });
});
