import { describe, expect, it } from "vitest";
import { parseHash } from "../../routes";
import type { GuideLink, GuideLinkKind } from "./api";
import { guideLinkHref } from "./links";

describe("guideLinkHref", () => {
  const cases: Array<[GuideLink, string | null]> = [
    [{ kind: "pipeline", id: "ship" }, "#/pipelines/ship"],
    [{ kind: "pipeline", id: "ship", projectRoot: "/work/app" }, "#/pipelines/ship?project_root=%2Fwork%2Fapp"],
    [{ kind: "stage", id: "build", path: "stages/build.stage.yaml" }, "#/stages/stages%2Fbuild.stage.yaml"],
    [{ kind: "stage", id: "build" }, null],
    [{ kind: "task", id: "weekly" }, "#/tasks/weekly"],
    [{ kind: "agent", id: "support" }, "#/agents/support"],
    [{ kind: "trigger", id: "nightly" }, "#/triggers/nightly"],
    [{ kind: "trigger", id: "nightly", projectRoot: "/p" }, "#/triggers/nightly?project_root=%2Fp"],
    [{ kind: "eval", id: "triage" }, "#/evals/triage"],
    [{ kind: "eval_run", id: "er_123" }, null],
    [{ kind: "dataset", id: "cases" }, "#/datasets/cases"],
    [{ kind: "connection", id: "slack-team" }, "#/connections/slack-team"],
    [{ kind: "memory", id: "style guide" }, "#/memories/style%20guide"],
    [{ kind: "run", id: "run_1" }, "#/runs/run_1"],
  ];

  it.each(cases)("%o -> %s", (link, href) => {
    expect(guideLinkHref(link)).toBe(href);
  });

  it("covers every kind", () => {
    const kinds: GuideLinkKind[] = ["pipeline", "stage", "task", "agent", "trigger", "eval", "eval_run", "dataset", "connection", "memory", "run"];
    expect(new Set(cases.map(([link]) => link.kind))).toEqual(new Set(kinds));
  });

  it("returns null without an id", () => {
    expect(guideLinkHref({ kind: "pipeline", id: "" })).toBeNull();
  });

  it("produces hashes the console router opens", () => {
    expect(parseHash(guideLinkHref({ kind: "pipeline", id: "ship", projectRoot: "/p" })!)).toEqual({ name: "pipeline", pipelineId: "ship", projectRoot: "/p" });
    expect(parseHash(guideLinkHref({ kind: "stage", id: "b", path: "stages/b.yaml" })!)).toEqual({ name: "stage", path: "stages/b.yaml" });
    expect(parseHash(guideLinkHref({ kind: "agent", id: "support" })!)).toEqual({ name: "agent", agentId: "support", screen: "detail" });
    expect(parseHash(guideLinkHref({ kind: "eval", id: "triage" })!)).toEqual({ name: "evalDetail", evalId: "triage" });
    expect(parseHash(guideLinkHref({ kind: "memory", id: "notes" })!)).toEqual({ name: "memory", memoryId: "notes" });
    expect(parseHash(guideLinkHref({ kind: "run", id: "r1" })!)).toEqual({ name: "detail", runId: "r1", view: { kind: "stream" } });
  });
});
