import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { composeStageUserPrompt } from "../src/agent/piAdapter.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  buildValidationResult,
  validateCatalog,
} from "../src/config/validateCatalog.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { PipelineValidationError, startPipeline } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import { checkTaskEntryInput } from "../src/runtime/taskInput.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { SAMPLE_TASK } from "./helpers/fixturePaths.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENTRY_INPUT_SCHEMA = [
  "          type: object",
  "          required: [title]",
  "          properties:",
  "            title:",
  "              type: string",
].join("\n");

async function writeEntryInputCatalog(options?: {
  secondRoot?: boolean;
}): Promise<{ cwd: string; pipelinePath: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "sf-entry-input-"));
  const pipelinePath = path.join(cwd, "entry-input.pipeline.yaml");
  const secondRoot = options?.secondRoot
    ? [
        "  - id: intake-b",
        "    system_prompt: Second root",
        "    entry: true",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "          required: [area_id]",
        "          properties:",
        "            area_id:",
        "              type: string",
      ]
    : [];
  await writeFile(
    pipelinePath,
    [
      "id: entry-input",
      "model: anthropic/claude-sonnet-4-5",
      "stages:",
      "  - id: intake",
      "    system_prompt: Collect input",
      "    entry: true",
      "    route:",
      "      - to: follow",
      "    io:",
      "      input:",
      "        schema:",
      ENTRY_INPUT_SCHEMA,
      "  - id: follow",
      "    system_prompt: Continue the work",
      ...secondRoot,
      "",
    ].join("\n"),
  );
  return { cwd, pipelinePath };
}

function successEmit(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
    },
  };
}

describe("runtime pipeline-owned smoke", () => {
  it("loaded pipeline stages align with dag nodes", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(loaded.stages.length).toBe(loaded.dag.nodes.length);
    expect(loaded.pipeline.stages.length).toBe(loaded.dag.nodes.length);
    const topoIds = loaded.dag.nodes.map((node) => node.id);
    expect(new Set(topoIds).size).toBe(topoIds.length);
    for (const stageId of loaded.pipeline.stages) {
      expect(loaded.dag.nodes.some((node) => node.id === stageId)).toBe(true);
    }
  });
});

describe("U6 task input pairing", () => {
  it("AE5: unpaired pipeline validate does not emit task.entry_input_unmet", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog();
    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: pipelinePath,
      cwd,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.code === "task.entry_input_unmet")).toBe(
      false,
    );
  });

  it("AE5: sample.task.yaml against entry io.input warns and start-run continues", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog();
    const loaded = await loadPipeline(pipelinePath, { cwd });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml);
    const findings = checkTaskEntryInput(task, loaded, {
      cwd,
      taskPath: SAMPLE_TASK,
    });
    expect(findings.some((f) => f.code === "task.entry_input_unmet")).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);

    const store = createRunStore({ rootDir: cwd });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      const started = await startPipeline({
        agent: scriptedFakeAgent([successEmit("intake"), successEmit("follow")]),
        store,
        taskPath: SAMPLE_TASK,
        pipeline: pipelinePath,
        cwd,
      });
      const result = await started.done;
      expect(result.ok).toBe(true);
      expect(result.findings?.some((f) => f.code === "task.entry_input_unmet")).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
    expect(logged.some((line) => line.includes("task.entry_input_unmet"))).toBe(
      true,
    );
  });

  it("task input matching each entry schema is clean", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog({
      secondRoot: true,
    });
    const loaded = await loadPipeline(pipelinePath, { cwd });
    const task = loadTaskFromYaml(
      [
        "id: t",
        "goal: g",
        "input:",
        "  title: Calendar",
        "  area_id: a1",
        "",
      ].join("\n"),
    );
    const findings = checkTaskEntryInput(task, loaded, { cwd });
    expect(findings).toEqual([]);
  });

  it("task input that misses one of two entry schemas fails prepare", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog({
      secondRoot: true,
    });
    const store = createRunStore({ rootDir: cwd });
    await expect(
      startPipeline({
        agent: scriptedFakeAgent([]),
        store,
        taskYaml: ["id: t", "goal: g", "input:", "  title: Calendar", ""].join(
          "\n",
        ),
        pipeline: pipelinePath,
        cwd,
      }),
    ).rejects.toBeInstanceOf(PipelineValidationError);
  });

  it("task input missing a required field fails prepare", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog();
    const store = createRunStore({ rootDir: cwd });
    await expect(
      startPipeline({
        agent: scriptedFakeAgent([]),
        store,
        taskYaml: ["id: t", "goal: g", "input:", "  other: x", ""].join("\n"),
        pipeline: pipelinePath,
        cwd,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PipelineValidationError);
      if (!(err instanceof PipelineValidationError)) return false;
      expect(err.result.ok).toBe(false);
      expect(
        err.result.findings.some(
          (f) => f.severity === "error" && f.code === "task.invalid_shape",
        ),
      ).toBe(true);
      return true;
    });
  });

  it("RunManager start-run with input round-trips into stored task YAML", async () => {
    const { cwd, pipelinePath } = await writeEntryInputCatalog();
    const store = createRunStore({ rootDir: cwd });
    const manager = new RunManager({
      agent: scriptedFakeAgent([successEmit("intake"), successEmit("follow")]),
      cwd,
      store,
    });
    const result = await manager.startRun({
      pipeline: pipelinePath,
      task: {
        id: "inline",
        goal: "prove input",
        input: { title: "From HTTP" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const yaml = await store.readTaskYaml(result.runId);
    const stored = loadTaskFromYaml(yaml);
    expect(stored.input).toEqual({ title: "From HTTP" });
    await result.done;
  });

  it("non-entry stage user prompt still contains task goal and input", () => {
    const prompt = composeStageUserPrompt(
      {
        roots: buildStageRoots("/tmp/run-ws", "follow"),
        stage: {
          id: "follow",
          system_prompt: "Continue",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: {
          id: "t",
          goal: "Design a calendar web app",
          input: { title: "Calendar" },
        },
        priorEnvelope: null,
      },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("Goal: Design a calendar web app");
    expect(prompt).toContain("Calendar");
  });

  it("STRICT_CATALOG_WARNINGS is unchanged and does not promote task.entry_input_unmet", async () => {
    const source = await readFile(
      path.join(root, "src", "config", "validateCatalog.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /const STRICT_CATALOG_WARNINGS = new Set<string>\(\[\s*"catalog\.manifest_missing",\s*"catalog\.empty_catalog",\s*\]\)/,
    );
    const result = buildValidationResult(
      "pipeline",
      [
        {
          severity: "warning",
          code: "task.entry_input_unmet",
          path: "tasks/sample.task.yaml",
          message: "unmet",
          category: "task",
        },
      ],
      true,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ errors: 0, warnings: 1 });
  });
});
