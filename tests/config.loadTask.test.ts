import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTaskFromYaml,
  loadTaskFromYamlOutcome,
  loadTaskOutcome,
  parseTaskFile,
} from "../src/config/loadTask.js";
import { isTaskFile, resolveStartTaskInput, taskFileToYaml } from "../src/runtime/taskInput.js";
import { validateCatalog } from "../src/config/validateCatalog.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const samplePath = SAMPLE_TASK;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("task load seam outcomes", () => {
  it("AE-S8-1: missing goal assigns task.invalid_shape at rule site", () => {
    const outcome = loadTaskFromYamlOutcome("id: no-goal\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.code).toBe("task.invalid_shape");
    expect(outcome.issues[0]?.category).toBe("task");
    expect(outcome.issues[0]?.message).toMatch(/id and goal are required strings/);
  });

  it("assigns task.load_error for malformed YAML", () => {
    const outcome = loadTaskFromYamlOutcome("id: [\n  - unclosed\n");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.load_error");
    expect(outcome.issues[0]?.category).toBe("task");
    expect(outcome.issues[0]?.message.length).toBeGreaterThan(0);
  });

  it("assigns task.load_error for a missing file", async () => {
    const missing = path.join(fixtures, "tasks", "does-not-exist.yaml");
    const outcome = await loadTaskOutcome(missing);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.load_error");
    expect(outcome.issues[0]?.category).toBe("task");
    expect(outcome.issues[0]?.message).toMatch(/ENOENT|no such file/i);
  });

  it("loads valid sample YAML as TaskFile", async () => {
    const yamlText = await readFile(samplePath, "utf8");
    const outcome = loadTaskFromYamlOutcome(yamlText, `task file ${samplePath}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({
      id: "sample",
      goal: "Design a calendar web app",
      context: "Personal productivity prototype",
      constraints: "Docs only; no implementation code",
      checkout: undefined,
    });
  });

  it("throw adapter keeps v1 missing id/goal message", () => {
    expect(() => loadTaskFromYaml("id: no-goal\n")).toThrow(
      /id and goal are required strings/,
    );
  });

  it("loadTask.ts does not import validateCatalog", async () => {
    const source = await readFile(path.join(root, "src", "config", "loadTask.ts"), "utf8");
    expect(source).not.toMatch(/validateCatalog/);
  });
});

describe("taskInput uses the load parse", () => {
  it("isTaskFile wraps parseTaskFile", () => {
    expect(isTaskFile({ id: "t", goal: "g" })).toBe(true);
    expect(isTaskFile({ id: "t", goal: "g", input: { title: "x" } })).toBe(true);
    expect(isTaskFile({ id: "t" })).toBe(false);
    expect(isTaskFile("tasks/sample.task.yaml")).toBe(false);
    expect(parseTaskFile({ id: "t", goal: "g", checkout: 42 }, "task").ok).toBe(true);
    expect(isTaskFile({ id: "t", goal: "g", checkout: 42 })).toBe(true);
  });

  it("object resolve uses parsed TaskFile and ignores non-string checkout", () => {
    const resolved = resolveStartTaskInput(
      { task: { id: "t", goal: "g", checkout: 42 } },
      fixtures,
    );
    expect(resolved.kind).toBe("yaml");
    if (resolved.kind !== "yaml") return;
    expect(resolved.taskYaml).toMatch(/id: t/);
    expect(resolved.taskYaml).toMatch(/goal: g/);
    expect(resolved.taskYaml).not.toMatch(/checkout/);
  });

  it("non-object task fails with the start-input error", () => {
    expect(() => resolveStartTaskInput({ task: 1 as unknown as string }, fixtures)).toThrow(
      /task path, task object, or taskYaml is required/,
    );
  });
});

describe("optional task input", () => {
  it("parses a structured input object", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      extra_unknown: "ignored",
      input: { title: "Calendar", count: 3 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.input).toEqual({ title: "Calendar", count: 3 });
    expect(outcome.value).not.toHaveProperty("extra_unknown");
  });

  it("rejects a non-object input at task load", () => {
    const outcome = parseTaskFile({ id: "t", goal: "g", input: "not-an-object" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.invalid_shape");
    expect(outcome.issues[0]?.message).toMatch(/input must be an object/);
  });

  it("rejects array input at task load", () => {
    const outcome = parseTaskFile({ id: "t", goal: "g", input: ["x"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.invalid_shape");
  });

  it("persists structured input through taskFileToYaml", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      input: { title: "Calendar" },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const yaml = taskFileToYaml(outcome.value);
    expect(yaml).toMatch(/input:/);
    expect(yaml).toMatch(/title: Calendar/);
    const reloaded = loadTaskFromYaml(yaml);
    expect(reloaded.input).toEqual({ title: "Calendar" });
  });

  it("MCP/HTTP start-run object with input round-trips into stored task YAML", () => {
    const resolved = resolveStartTaskInput(
      {
        task: {
          id: "inline",
          goal: "prove input",
          input: { title: "From start-run" },
        },
      },
      fixtures,
    );
    expect(resolved.kind).toBe("yaml");
    if (resolved.kind !== "yaml") return;
    expect(resolved.taskYaml).toMatch(/title: From start-run/);
    const stored = loadTaskFromYaml(resolved.taskYaml);
    expect(stored.input).toEqual({ title: "From start-run" });
  });

  it("AE5: sample.task.yaml still validates alone without task.entry_input_unmet", async () => {
    const result = await validateCatalog({
      scope: "task",
      task: samplePath,
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.code === "task.entry_input_unmet")).toBe(
      false,
    );
  });

  it("MCP taskFileSchema includes optional input", async () => {
    const source = await readFile(
      path.join(root, "src", "mcp", "catalogTools.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /input:\s*z\.record\(z\.string\(\),\s*z\.unknown\(\)\)\.optional\(\)/,
    );
  });
});
