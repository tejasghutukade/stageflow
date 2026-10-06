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
import { resolveWorkspaceBinding } from "../src/runtime/workspaceBinding.js";
import { validateCatalog } from "../src/config/validateCatalog.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const samplePath = SAMPLE_TASK;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withRepositoryPath = path.join(fixtures, "tasks", "with-repository.task.yaml");
const bindingConflictPath = path.join(fixtures, "tasks", "binding-conflict.task.yaml");
const missingRefPath = path.join(fixtures, "tasks", "missing-ref.task.yaml");
const invalidRepositoryPath = path.join(fixtures, "tasks", "invalid-repository.task.yaml");
const invalidRepositoryUrlPath = path.join(fixtures, "tasks", "invalid-repository-url.task.yaml");

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
    expect(source).toMatch(/repository:\s*z\.string\(\)\.optional\(\)/);
    expect(source).toMatch(/ref:\s*z\.string\(\)\.optional\(\)/);
    expect(source).toMatch(/checkout:\s*z[\s\S]*?\.string\(\)\.optional\(\)/);
    expect(source).toMatch(/checkout_override:\s*z[\s\S]*?\.string\(\)\.optional\(\)/);
    expect(source).toMatch(/skip_gates:\s*z\.boolean\(\)\.optional\(\)/);
  });
});

describe("workspace binding XOR (U1)", () => {
  it("happy: repository+ref resolves to kind repository", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "acme/api",
      ref: "main",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repository).toBe("acme/api");
    expect(outcome.value.ref).toBe("main");
    const binding = resolveWorkspaceBinding(outcome.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value).toEqual({
      kind: "repository",
      repository: "acme/api",
      ref: "main",
    });
  });

  it("happy: path-only checkout resolves to kind checkout", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      checkout: "/abs/project/checkout",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const binding = resolveWorkspaceBinding(outcome.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value).toEqual({
      kind: "checkout",
      path: "/abs/project/checkout",
    });
  });

  it("happy: neither field resolves to unbound", () => {
    const outcome = parseTaskFile({ id: "t", goal: "g" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const binding = resolveWorkspaceBinding(outcome.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value).toEqual({ kind: "unbound" });
  });

  it("edge: whitespace-only ref yields task.repository_ref_required", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "acme/api",
      ref: "   ",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_ref_required");
    expect(outcome.issues[0]?.category).toBe("task");
  });

  it("error: both repository and checkout yields task.binding_conflict", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "acme/api",
      ref: "main",
      checkout: "/abs/project/checkout",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.binding_conflict");
  });

  it("error: ref without repository yields task.ref_without_repository", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      ref: "main",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.ref_without_repository");
  });

  it("error: gitlab host path yields task.repository_invalid", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "gitlab.com/a/b",
      ref: "main",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_invalid");
  });

  it("error: full URL yields task.repository_invalid", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "https://github.com/acme/api",
      ref: "main",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_invalid");
  });

  it("unknown-key drop no longer eats repository/ref/templates/identity", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "acme/api",
      ref: "main",
      run_branch_template: "stageflow/flaky-<runId>",
      git_identity: { name: "Bot", email: "bot@example.com" },
      extra_unknown: "ignored",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repository).toBe("acme/api");
    expect(outcome.value.ref).toBe("main");
    expect(outcome.value.run_branch_template).toBe("stageflow/flaky-<runId>");
    expect(outcome.value.git_identity).toEqual({
      name: "Bot",
      email: "bot@example.com",
    });
    expect(outcome.value).not.toHaveProperty("extra_unknown");
  });

  it("integration: taskFileToYaml round-trip preserves binding fields", () => {
    const outcome = parseTaskFile({
      id: "t",
      goal: "g",
      repository: "acme/api",
      ref: "main",
      run_branch_template: "stageflow/run-<runId>",
      git_identity: { name: "Stageflow", email: "stageflow@localhost" },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const yaml = taskFileToYaml(outcome.value);
    expect(yaml).toMatch(/repository: acme\/api/);
    expect(yaml).toMatch(/ref: main/);
    expect(yaml).toMatch(/run_branch_template:/);
    expect(yaml).toMatch(/git_identity:/);
    const reloaded = loadTaskFromYaml(yaml);
    expect(reloaded.repository).toBe("acme/api");
    expect(reloaded.ref).toBe("main");
    expect(reloaded.run_branch_template).toBe("stageflow/run-<runId>");
    expect(reloaded.git_identity).toEqual({
      name: "Stageflow",
      email: "stageflow@localhost",
    });
  });

  it("fixture with-repository.task.yaml loads as repository binding", async () => {
    const outcome = await loadTaskOutcome(withRepositoryPath);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.repository).toBe("acme/api");
    expect(outcome.value.ref).toBe("main");
    const binding = resolveWorkspaceBinding(outcome.value);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value.kind).toBe("repository");
  });

  it("fixture binding-conflict.task.yaml fails with task.binding_conflict", async () => {
    const outcome = await loadTaskOutcome(bindingConflictPath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.binding_conflict");
  });

  it("fixture missing-ref.task.yaml fails with task.repository_ref_required", async () => {
    const outcome = await loadTaskOutcome(missingRefPath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_ref_required");
  });

  it("fixture invalid-repository.task.yaml fails with task.repository_invalid", async () => {
    const outcome = await loadTaskOutcome(invalidRepositoryPath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_invalid");
  });

  it("fixture invalid-repository-url.task.yaml fails with task.repository_invalid", async () => {
    const outcome = await loadTaskOutcome(invalidRepositoryUrlPath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("task.repository_invalid");
  });

  it("sf validate reports fixture binding codes", async () => {
    const conflict = await validateCatalog({
      scope: "task",
      task: bindingConflictPath,
      cwd: fixtures,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.findings.some((f) => f.code === "task.binding_conflict")).toBe(true);

    const missing = await validateCatalog({
      scope: "task",
      task: missingRefPath,
      cwd: fixtures,
    });
    expect(missing.ok).toBe(false);
    expect(missing.findings.some((f) => f.code === "task.repository_ref_required")).toBe(
      true,
    );
  });
});
