import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadTask } from "../src/config/loadTask.js";
import { validateCatalog } from "../src/config/validateCatalog.js";
import { compilePayloadSchema } from "../src/envelope/payloadSchema.js";
import { checkTaskEntryInput } from "../src/runtime/taskInput.js";
import { PIPELINE_OWNED } from "./helpers/fixturePaths.js";

const targetDialect = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/target-dialect",
);

const pipelineFile = path.join(targetDialect, "demo.pipeline.yaml");
const taskFile = path.join(targetDialect, "demo.task.yaml");

const topicBriefSchema = {
  type: "object",
  required: ["topic"],
  properties: {
    topic: { type: "string" },
  },
  additionalProperties: false,
};

describe("target-dialect teaching fixtures", () => {
  it("loads verify, on_verify_fail, and pipeline schemas $ref onto IR", async () => {
    const pipelineYaml = await readFile(pipelineFile, "utf8");
    expect(pipelineYaml).toMatch(/^schemas:/m);
    expect(pipelineYaml).toMatch(/on_verify_fail:/);

    const intakeYaml = await readFile(path.join(targetDialect, "intake.yaml"), "utf8");
    expect(intakeYaml).toMatch(/^io:/m);
    expect(intakeYaml).toMatch(/\$ref:\s*"#\/schemas\/topic-brief"/);
    expect(intakeYaml).not.toMatch(/^payload_schema:/m);

    const draftYaml = await readFile(path.join(targetDialect, "draft.yaml"), "utf8");
    expect(draftYaml).toMatch(/^verify:/m);
    expect(draftYaml).not.toMatch(/^completion:/m);
    expect(draftYaml).not.toMatch(/^pre_emit_checks:/m);

    const loaded = await loadPipeline(pipelineFile, { cwd: targetDialect });

    expect(loaded.pipeline.id).toBe("target-dialect-demo");
    expect(loaded.pipeline.stages).toEqual(["intake", "draft"]);
    expect(loaded.pipeline.schemas).toEqual({ "topic-brief": topicBriefSchema });

    const intake = loaded.stages.find((stage) => stage.id === "intake");
    const draft = loaded.stages.find((stage) => stage.id === "draft");
    expect(intake?.clone_input_schema).toEqual(topicBriefSchema);
    expect(intake?.payload_schema).toEqual(topicBriefSchema);
    expect(draft?.clone_input_schema).toEqual(topicBriefSchema);
    expect(() => compilePayloadSchema(intake?.payload_schema)).not.toThrow();
    expect(() => compilePayloadSchema(draft?.clone_input_schema)).not.toThrow();

    expect(draft?.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    const draftNode = loaded.dag.nodes.find((node) => node.id === "draft");
    expect(draftNode?.completion).toEqual({
      mode: "all",
      checks: [{ id: "brief", type: "artifact", path: "brief.md" }],
    });
    expect(draftNode?.recovery).toEqual({
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });
  });

  it("pairs task.input with entry io.input without unmet findings", async () => {
    const loaded = await loadPipeline(pipelineFile, { cwd: targetDialect });
    const task = await loadTask(taskFile);
    expect(task.input).toEqual({
      topic: "Calendar apps for personal productivity",
    });
    const findings = checkTaskEntryInput(task, loaded, {
      cwd: targetDialect,
      taskPath: taskFile,
    });
    expect(findings).toEqual([]);
  });

  it("validateCatalog accepts the pipeline and task shapes", async () => {
    const pipelineResult = await validateCatalog({
      scope: "pipeline",
      pipeline: pipelineFile,
      cwd: targetDialect,
    });
    expect(pipelineResult.ok).toBe(true);
    expect(
      pipelineResult.findings.some((f) => f.code === "catalog.legacy_yaml"),
    ).toBe(false);

    const taskResult = await validateCatalog({
      scope: "task",
      task: taskFile,
      cwd: targetDialect,
    });
    expect(taskResult.ok).toBe(true);
  });

  it("mixed-dialect negative fixture still fails closed", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(PIPELINE_OWNED, "negative/mixed-dialect.pipeline.yaml"),
      { cwd: PIPELINE_OWNED },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")).toBe(
      true,
    );
  });
});
