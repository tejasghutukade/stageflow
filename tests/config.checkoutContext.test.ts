import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { checkTaskEntryInput } from "../src/runtime/taskInput.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { PipelineValidationError } from "../src/runtime/pipelineValidationError.js";
import { createRunStore } from "../src/runstore/createStore.js";

async function writeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-checkout-context-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

const stageBody = (id = "plan", extra: string[] = []) =>
  [
    `  - id: ${id}`,
    "    system_prompt: Do the checkout work",
    ...extra,
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "      output:",
    "        schema:",
    "          type: object",
  ].join("\n");

function pipeline(lines: string[]): string {
  return [...lines, ""].join("\n");
}

const stageFile = (extra: string[] = []) =>
  [
    "id: plan",
    "system_prompt: Do the checkout work",
    ...extra,
    "io:",
    "  input:",
    "    schema:",
    "      type: object",
    "  output:",
    "    schema:",
    "      type: object",
    "",
  ].join("\n");

describe("checkout_context catalog", () => {
  it("accepts the flag on a stage body and leaves it off when omitted or false", async () => {
    const root = await writeRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody("plan", ["    checkout_context: true"]),
        stageBody("other", ["    checkout_context: false"]),
        stageBody("plain"),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byId = new Map(outcome.value.stages.map((stage) => [stage.id, stage]));
    expect(byId.get("plan")?.checkout_context).toBe(true);
    expect(byId.get("plan")?.system_prompt).toBe("Do the checkout work");
    expect(byId.get("other")?.checkout_context).toBeUndefined();
    expect(byId.get("plain")?.checkout_context).toBeUndefined();
  });

  it("keeps the flag independent of independence", async () => {
    const root = await writeRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: open",
        "stages:",
        stageBody("plan", ["    independence: strict", "    checkout_context: true"]),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("strict");
    expect(outcome.value.stages[0]?.checkout_context).toBe(true);
  });

  it("does not inherit a top-level copy from the pipeline, a fragment, or the manifest", async () => {
    const root = await writeRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        "model: openai/gpt-4o",
        "checkout_context: true",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "fragments/extra.yaml": pipeline([
        "checkout_context: true",
        "stages:",
        stageBody("from-fragment"),
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "checkout_context: true",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages:",
        stageBody(),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages.every((stage) => stage.checkout_context !== true)).toBe(true);
  });

  it("accepts the flag on a stage body inside a fragment and on an external stage file", async () => {
    const root = await writeRoot({
      "plan.stage.yaml": stageFile(["checkout_context: true"]),
      "fragments/extra.yaml": pipeline([
        "checkout_context: false",
        "stages:",
        stageBody("from-fragment", ["    checkout_context: true"]),
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages:",
        "  - id: plan",
        "    uses: ./plan.stage.yaml",
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byId = new Map(outcome.value.stages.map((stage) => [stage.id, stage]));
    expect(byId.get("plan")?.checkout_context).toBe(true);
    expect(byId.get("from-fragment")?.checkout_context).toBe(true);
  });

  it("parses a stage file that sets the flag without a checkout", async () => {
    const root = await writeRoot({
      "plan.stage.yaml": stageFile(["checkout_context: true"]),
    });
    const outcome = await loadStageOutcome(path.join(root, "plan.stage.yaml"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.checkout_context).toBe(true);
    expect(outcome.value.system_prompt).toBe("Do the checkout work");
  });

  it("rejects a non-boolean flag", async () => {
    const root = await writeRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody("plan", ["    checkout_context: 1"]),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "stage.invalid_checkout_context")).toBe(true);
  });

  it("fails the pipeline-and-task join when the flag is on and the task is unbound", async () => {
    const root = await writeRoot({
      "AGENTS.md": "PROJECT-ROOT-AGENTS",
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody("plan", ["    checkout_context: true"]),
      ]),
    });
    const loaded = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unbound = loadTaskFromYaml("id: t\ngoal: g\n");
    const findings = checkTaskEntryInput(unbound, loaded.value, { cwd: root });
    expect(findings.some((finding) => finding.severity === "error" && finding.code === "stage.checkout_context_unbound")).toBe(
      true,
    );

    const store = createRunStore({ rootDir: path.join(root, "runs") });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "ok", artifacts: [], payload: {} } },
    ]);
    let caught: PipelineValidationError | undefined;
    try {
      await startPipeline({
        agent,
        store,
        taskYaml: "id: t\ngoal: g\n",
        pipeline: path.join(root, "demo.pipeline.yaml"),
        cwd: root,
        projectRoot: root,
      });
    } catch (err) {
      caught = err as PipelineValidationError;
    }
    expect(caught).toBeInstanceOf(PipelineValidationError);
    expect(
      caught!.result.findings.some(
        (finding) => finding.severity === "error" && finding.code === "stage.checkout_context_unbound",
      ),
    ).toBe(true);
    expect(agent.recorded).toEqual([]);
  });

  it("accepts the flag when the task sets checkout or repository, and when the flag is off", async () => {
    const root = await writeRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody("plan", ["    checkout_context: true"]),
      ]),
      "off.pipeline.yaml": pipeline([
        "id: off",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(),
      ]),
    });
    const on = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    const off = await loadPipelineOutcome("off.pipeline.yaml", { cwd: root });
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;

    const checkoutTask = loadTaskFromYaml("id: t\ngoal: g\ncheckout: ./repo\n");
    const repositoryTask = loadTaskFromYaml("id: t\ngoal: g\nrepository: acme/api\nref: main\n");
    const unbound = loadTaskFromYaml("id: t\ngoal: g\n");

    expect(checkTaskEntryInput(checkoutTask, on.value, { cwd: root })).toEqual([]);
    expect(checkTaskEntryInput(repositoryTask, on.value, { cwd: root })).toEqual([]);
    expect(
      checkTaskEntryInput(unbound, off.value, { cwd: root }).some(
        (finding) => finding.code === "stage.checkout_context_unbound",
      ),
    ).toBe(false);
    expect(
      checkTaskEntryInput(unbound, on.value, { cwd: root, checkoutOverride: "./repo" }).some(
        (finding) => finding.code === "stage.checkout_context_unbound",
      ),
    ).toBe(false);
  });
});
