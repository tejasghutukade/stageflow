import { describe, expect, it } from "vitest";
import type { PipelineListing, SkillListing } from "../../api";
import {
  findSkillPipeline,
  flattenGroups,
  groupSkills,
  isBuiltInSkill,
  matchesSkillQuery,
  skillFilterCounts,
  skillInvocationLabel,
  skillScopeLabel,
  skillSourceLabel,
  skillsFolderLabel,
  stepSelection,
  usedByRows,
  visibleSkills,
  type SkillUsages,
} from "./catalogSkillModel";

function skill(overrides: Partial<SkillListing>): SkillListing {
  return {
    name: "x",
    description: "",
    filePath: "/repo/.pi/skills/x/SKILL.md",
    baseDir: "/repo/.pi/skills/x",
    scope: "project",
    source: "project",
    disableModelInvocation: false,
    ...overrides,
  };
}

const skills: SkillListing[] = [
  skill({ name: "code-review", description: "Review a diff" }),
  skill({ name: "test-writer", description: "Write tests" }),
  skill({ name: "archify", scope: "user", source: "~/.pi/agent/skills" }),
  skill({
    name: "sql-migrations",
    scope: "temporary",
    disableModelInvocation: true,
  }),
  skill({
    name: "browser",
    scope: "user",
    source: "stageflow built-in",
  }),
];

const usages: SkillUsages = {
  "code-review": { stage_ids: ["review"], pipeline_ids: ["a", "b", "c"] },
  "test-writer": { stage_ids: ["test"], pipeline_ids: ["a"] },
  archify: { stage_ids: [], pipeline_ids: [] },
};

describe("catalogSkillModel", () => {
  it("labels invocation", () => {
    expect(skillInvocationLabel(skills[0]!)).toBe("model");
    expect(skillInvocationLabel(skills[3]!)).toBe("command-only");
  });

  it("detects built-in from source or filePath case-insensitively", () => {
    expect(isBuiltInSkill(skills[4]!)).toBe(true);
    expect(
      isBuiltInSkill(skill({ filePath: "/opt/Built-In/skills/a/SKILL.md" })),
    ).toBe(true);
    expect(isBuiltInSkill(skills[0]!)).toBe(false);
    expect(skillScopeLabel(skills[4]!)).toBe("built-in");
    expect(skillScopeLabel(skills[2]!)).toBe("user");
  });

  it("matches query against name, description and source", () => {
    expect(matchesSkillQuery(skills[0]!, "REVIEW")).toBe(true);
    expect(matchesSkillQuery(skills[1]!, "write")).toBe(true);
    expect(matchesSkillQuery(skills[2]!, "agent/skills")).toBe(true);
    expect(matchesSkillQuery(skills[2]!, "nope")).toBe(false);
    expect(matchesSkillQuery(skills[2]!, "  ")).toBe(true);
  });

  it("filters by chip and counts each chip", () => {
    expect(visibleSkills(skills, "used", "", usages).map((s) => s.name)).toEqual(
      ["code-review", "test-writer"],
    );
    expect(visibleSkills(skills, "user", "", usages)).toHaveLength(2);
    expect(visibleSkills(skills, "built-in", "", usages)).toHaveLength(1);
    expect(visibleSkills(skills, "all", "write", usages)).toHaveLength(1);
    expect(skillFilterCounts(skills, usages)).toEqual({
      all: 5,
      used: 2,
      project: 2,
      user: 2,
      temporary: 1,
      "built-in": 1,
    });
  });

  it("built-in count is zero when nothing mentions built-in", () => {
    expect(skillFilterCounts(skills.slice(0, 4), usages)["built-in"]).toBe(0);
  });

  it("groups used skills by pipeline count then name, available by name", () => {
    const groups = groupSkills(skills, usages);
    expect(groups.map((g) => g.id)).toEqual(["used", "available"]);
    expect(groups[0]!.skills.map((s) => s.name)).toEqual([
      "code-review",
      "test-writer",
    ]);
    expect(groups[1]!.skills.map((s) => s.name)).toEqual([
      "archify",
      "browser",
      "sql-migrations",
    ]);
  });

  it("skips empty groups", () => {
    expect(groupSkills(skills, {}).map((g) => g.id)).toEqual(["available"]);
    expect(groupSkills([], usages)).toEqual([]);
  });

  it("steps selection within the flattened list", () => {
    const names = flattenGroups(groupSkills(skills, usages)).map((s) => s.name);
    expect(stepSelection(names, null, 1)).toBe("code-review");
    expect(stepSelection(names, "code-review", 1)).toBe("test-writer");
    expect(stepSelection(names, "code-review", -1)).toBe("code-review");
    expect(stepSelection(names, "sql-migrations", 1)).toBe("sql-migrations");
    expect(stepSelection([], "a", 1)).toBeNull();
  });

  it("shows source or falls back to filePath", () => {
    expect(skillSourceLabel(skills[2]!)).toBe("~/.pi/agent/skills");
    expect(skillSourceLabel(skill({ source: "" }))).toBe(
      "/repo/.pi/skills/x/SKILL.md",
    );
  });

  it("derives the footer folder", () => {
    expect(skillsFolderLabel(skills.slice(0, 2))).toBe("/repo/.pi/skills");
    expect(
      skillsFolderLabel([skill({ baseDir: "/a/x" }), skill({ baseDir: "/b/y" })]),
    ).toBe(".pi/skills");
  });

  it("builds used-by rows from usage only", () => {
    expect(usedByRows(usages["code-review"]!)).toEqual([
      { pipelineId: "a", stageId: "review" },
      { pipelineId: "b", stageId: "review" },
      { pipelineId: "c", stageId: "review" },
    ]);
    expect(usedByRows({ stage_ids: ["s1"], pipeline_ids: [] })).toEqual([
      { pipelineId: null, stageId: "s1" },
    ]);
    expect(
      usedByRows({
        stage_ids: [],
        pipeline_ids: Array.from({ length: 12 }, (_, i) => `p${i}`),
      }),
    ).toHaveLength(8);
  });

  it("links a pipeline only when a stage declares the skill", () => {
    const pipelines = [
      { path: "a.yaml", id: "a", stages: [{ id: "review" }], project_root: "/r" },
      {
        path: "b.yaml",
        id: "b",
        stages: [{ id: "review", skill: "code-review" }],
        project_root: "/r",
      },
    ] as PipelineListing[];
    expect(findSkillPipeline(pipelines, "a", "code-review")).toBeNull();
    expect(findSkillPipeline(pipelines, "b", "code-review")?.path).toBe("b.yaml");
    expect(findSkillPipeline(pipelines, "b", "other")).toBeNull();
  });
});
