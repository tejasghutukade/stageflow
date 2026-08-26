import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, taskPath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines } from "../src/config/listConfig.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadStage } from "../src/config/loadStage.js";
import { loadTask, loadTaskFromYaml } from "../src/config/loadTask.js";
import { areResolvedDagsEquivalent } from "../src/config/resolvePipelineDag.js";
import {
  resolveAndValidateCheckout,
  resolveCheckoutPath,
} from "../src/runtime/stageRoots.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("YAML loaders", () => {
  it.skip("legacy three-dir pipeline load — migrated in S7", async () => {
    const loaded = await loadPipeline(pipelinePath("docs-only"), { cwd: fixtures });
    expect(loaded.pipeline.stages).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);
  });

  it.skip("legacy broken pipeline missing stage — migrated in S7", async () => {
    await expect(loadPipeline(pipelinePath("broken"), { cwd: fixtures })).rejects.toThrow(
      /missing stage/,
    );
  });

  it("loads a structured task with goal and context", async () => {
    const task = await loadTask(SAMPLE_TASK);
    expect(task.goal).toMatch(/calendar/i);
    expect(task.context).toBeTruthy();
    expect(task.checkout).toBeUndefined();
  });

  it("loads a task with absolute checkout", async () => {
    const task = await loadTask(taskPath("with-checkout"));
    expect(task.checkout).toBe("/abs/project/checkout");
  });

  it("ignores non-string checkout like other optional fields", () => {
    const task = loadTaskFromYaml(`
id: bad-checkout
goal: Something
checkout: 42
`);
    expect(task.checkout).toBeUndefined();
  });

  it.skip("legacy valid fixture pipelines — migrated in S7", async () => {
    const validPipelineIds = [
      "docs-only",
      "single",
      "plan-review-proving",
      "hitl-four-kinds-proving",
      "parallel-after-clarify",
      "linear-explicit",
    ];
    for (const pipelineId of validPipelineIds) {
      const loaded = await loadPipeline(pipelineId, { cwd: fixtures });
      expect(loaded.dag.nodes.length).toBe(loaded.pipeline.stages.length);
    }
  });

  it.skip("legacy fan-out fixture — migrated in S7", async () => {
    const loaded = await loadPipeline(pipelinePath("parallel-after-clarify"), { cwd: fixtures });
    expect(loaded.dag.roots).toEqual(["clarify"]);
  });

  it.skip("legacy explicit linear fixture — migrated in S7", async () => {
    const docsOnly = await loadPipeline(pipelinePath("docs-only"), { cwd: fixtures });
    const linearExplicit = await loadPipeline(pipelinePath("linear-explicit"), { cwd: fixtures });
    expect(areResolvedDagsEquivalent(docsOnly.dag, linearExplicit.dag)).toBe(true);
  });

  it.skip("legacy single-stage pipeline — migrated in S7", async () => {
    const loaded = await loadPipeline(pipelinePath("single"), { cwd: fixtures });
    expect(loaded.stages).toHaveLength(1);
  });

  it("loads declared gate_kinds from HITL stage YAML", async () => {
    const planReview = await loadStage(
      path.join(fixtures, "stages", "plan-review.yaml"),
    );
    expect(planReview.gate_kinds).toEqual(["artifact_backed"]);

    const fourKinds = await loadStage(
      path.join(fixtures, "stages", "hitl-four-kinds.yaml"),
    );
    expect(fourKinds.gate_kinds).toEqual([
      "free_text",
      "confirm",
      "multi_question",
      "artifact_backed",
    ]);

    const followup = await loadStage(
      path.join(fixtures, "stages", "plan-review-followup.yaml"),
    );
    expect(followup.gate_kinds).toBeUndefined();
  });

  it("rejects unknown or non-array gate_kinds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-gate-kinds-"));
    const unknownKind = path.join(dir, "unknown.yaml");
    await writeFile(
      unknownKind,
      [
        "id: unknown",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds:",
        "  - not_a_kind",
        "",
      ].join("\n"),
    );
    await expect(loadStage(unknownKind)).rejects.toThrow(/unsupported gate kind/);

    const notArray = path.join(dir, "not-array.yaml");
    await writeFile(
      notArray,
      [
        "id: not-array",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds: artifact_backed",
        "",
      ].join("\n"),
    );
    await expect(loadStage(notArray)).rejects.toThrow(
      /gate_kinds must be an array of strings/,
    );
  });

  it("loads optional skill name from stage YAML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-skill-"));
    const named = path.join(dir, "named.yaml");
    await writeFile(
      named,
      [
        "id: named",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "skill: improve-codebase-architecture",
        "",
      ].join("\n"),
    );
    expect((await loadStage(named)).skill).toBe("improve-codebase-architecture");

    const omitted = path.join(dir, "omitted.yaml");
    await writeFile(
      omitted,
      [
        "id: omitted",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );
    expect((await loadStage(omitted)).skill).toBeUndefined();
  });

  it("rejects empty, whitespace-only, and non-string skill", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-skill-bad-"));
    const cases: Array<{ name: string; skillLine: string }> = [
      { name: "empty", skillLine: 'skill: ""' },
      { name: "whitespace", skillLine: 'skill: "   "' },
      { name: "list", skillLine: "skill:\n  - a\n  - b" },
      { name: "number", skillLine: "skill: 1" },
    ];
    for (const { name, skillLine } of cases) {
      const filePath = path.join(dir, `${name}.yaml`);
      await writeFile(
        filePath,
        [
          `id: ${name}`,
          "system_prompt: x",
          "model: anthropic/claude-sonnet-4-5",
          skillLine,
          "",
        ].join("\n"),
      );
      await expect(loadStage(filePath)).rejects.toThrow(/skill/);
    }
  });

  it.skip("lists pipelines with per-stage gate_kinds objects — legacy fixtures S7", async () => {
    const pipelines = await listPipelines(fixtures);
    const proving = pipelines.find((p) => p.id === "plan-review-proving");
    expect(proving?.stages).toEqual([
      { id: "plan-review", gate_kinds: ["artifact_backed"] },
      { id: "plan-review-followup" },
    ]);

    const fourKinds = pipelines.find((p) => p.id === "hitl-four-kinds-proving");
    expect(fourKinds?.stages).toEqual([
      {
        id: "hitl-four-kinds",
        gate_kinds: [
          "free_text",
          "confirm",
          "multi_question",
          "artifact_backed",
        ],
      },
    ]);

    const docsOnly = pipelines.find((p) => p.id === "docs-only");
    expect(docsOnly?.stages.every((s) => s.gate_kinds === undefined)).toBe(true);
  });
});

describe("checkout path helpers", () => {
  it("resolves relative checkout against provided cwd", () => {
    const cwd = "/factory/root";
    expect(resolveCheckoutPath("../sibling-project", cwd)).toBe(
      path.resolve(cwd, "../sibling-project"),
    );
  });

  it("returns undefined when neither override nor task checkout is set", async () => {
    expect(
      await resolveAndValidateCheckout({ id: "t", goal: "g" }, undefined, "/factory"),
    ).toBeUndefined();
  });

  it("prefers CLI override over task checkout", async () => {
    const fromCli = await mkdtemp(path.join(tmpdir(), "sf-cli-"));
    const fromTask = await mkdtemp(path.join(tmpdir(), "sf-task-"));
    const task = {
      id: "t",
      goal: "g",
      checkout: fromTask,
    };
    expect(
      await resolveAndValidateCheckout(task, fromCli, "/factory"),
    ).toBe(fromCli);
  });

  it("uses task checkout when no CLI override", async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-task-co-"));
    const task = {
      id: "t",
      goal: "g",
      checkout,
    };
    expect(await resolveAndValidateCheckout(task, undefined, "/factory")).toBe(
      checkout,
    );
  });

  it("rejects empty checkout strings", async () => {
    await expect(
      resolveAndValidateCheckout({ id: "t", goal: "g", checkout: "  " }, undefined, "/f"),
    ).rejects.toThrow(/empty or whitespace/);
  });
});
