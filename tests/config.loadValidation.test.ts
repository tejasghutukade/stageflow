import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadPipelineValidated, validatePipeline } from "../src/config/validateCatalog.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { compilePayloadSchema } from "../src/envelope/payloadSchema.js";
import { pipelinePath, REPO_ROOT } from "./helpers/fixturePaths.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);

describe("load seam outcomes", () => {
  it("missing uses target assigns pipeline.missing_stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-missing-"));
    const pipelinePath = path.join(root, "broken.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: broken",
        "stages:",
        "  - id: missing",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.missing_stage")).toBe(
      true,
    );
  });

  it("dag cycle assigns pipeline.dag_error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-cycle-"));
    const pipelinePath = path.join(root, "cycle.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: cycle",
        "stages:",
        "  - id: a",
        "    entry: true",
        "    route:",
        "      - to: b",
        "    system_prompt: x",
        "    model: m",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "  - id: b",
        "    route:",
        "      - to: a",
        "    system_prompt: x",
        "    model: m",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(true);
  });

  it("assigns pipeline.invalid_shape for missing id and stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-shape-"));
    const pipelinePath = path.join(root, "bad.pipeline.yaml");
    await writeFile(pipelinePath, "not_a_pipeline: true\n");
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_shape");
  });

  const SCHEMA_IO = [
    "io:",
    "  input:",
    "    schema:",
    "      type: object",
    "  output:",
    "    schema:",
    "      type: object",
  ];

  it.each([
    { code: "stage.invalid_shape", lines: ["id: bad"] },
    {
      code: "stage.invalid_payload_schema",
      lines: ["id: bad", "system_prompt: test", "model: anthropic/claude-sonnet-4-5", "payload_schema:", "  type: not-a-valid-type"],
    },
    {
      code: "stage.invalid_gate_kinds",
      lines: ["id: bad", "system_prompt: test", "model: anthropic/claude-sonnet-4-5", ...SCHEMA_IO, "gate_kinds:", "  - not_a_kind"],
    },
    {
      code: "stage.invalid_clone_input_schema",
      lines: ["id: bad", "system_prompt: test", "model: anthropic/claude-sonnet-4-5", "clone_input_schema:", "  type: not-a-valid-type"],
    },
  ])("loadStageOutcome assigns $code", async ({ code, lines }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-stage-issue-"));
    const stagePath = path.join(root, "bad.yaml");
    await writeFile(stagePath, [...lines, ""].join("\n"), "utf8");
    const outcome = await loadStageOutcome(stagePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe(code);
  });

  it("loadPipeline throws for missing uses target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-throw-"));
    const pipelinePath = path.join(root, "broken.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: broken",
        "stages:",
        "  - id: missing",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(pipelinePath)).rejects.toThrow(/missing stage/i);
  });
});

describe("loadPipelineValidated", () => {
  it("returns loaded pipeline on success", async () => {
    const result = await loadPipelineValidated(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loaded.pipeline.id).toBe("fork-demo");
    expect(result.loaded.stages.map((st) => st.id)).toEqual(["decide", "branch-a", "branch-b"]);
  });

  it("returns pipeline.stage_id_mismatch finding", async () => {
    const result = await loadPipelineValidated(
      path.join(owned, "negative/id-mismatch.pipeline.yaml"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.findings.some((finding) => finding.code === "pipeline.stage_id_mismatch"),
    ).toBe(true);
  });

  it("fails on a bare-string stage ref with pipeline.string_stage_ref", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-multi-"));
    const pipelinePath = path.join(root, "multi.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: multi",
        "stages:",
        "  - decide",
        "  - id: bad",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    const result = await loadPipelineValidated(pipelinePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.map((f) => f.code)).toEqual(["pipeline.string_stage_ref"]);
  });
});

async function writeTempFiles(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-io-ref-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}


function ioPipeline(opts: {
  id: string;
  producerOut: string[];
  consumerIn: string[];
}): string {
  const indent = (lines: string[]) => lines.map((line) => `          ${line}`);
  return [
    `id: ${opts.id}`,
    "model: anthropic/claude-sonnet-4-5",
    "stages:",
    "  - id: produce",
    "    entry: true",
    "    route:",
    "      - to: consume",
    "    system_prompt: Produce",
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "      output:",
    "        schema:",
    ...indent(opts.producerOut),
    "  - id: consume",
    "    system_prompt: Consume",
    "    io:",
    "      input:",
    "        schema:",
    ...indent(opts.consumerIn),
    "      output:",
    "        schema:",
    "          type: object",
    "",
  ].join("\n");
}

function joinPipeline(opts: { id: string; leftOut: string[]; rightOut: string[] }): string {
  const indent = (lines: string[]) => lines.map((line) => `          ${line}`);
  const parent = (id: string, out: string[]) => [
    `  - id: ${id}`,
    `    system_prompt: ${id}`,
    "    entry: true",
    "    route:",
    "      - to: merge",
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "      output:",
    "        schema:",
    ...indent(out),
  ];
  return [
    `id: ${opts.id}`,
    "model: anthropic/claude-sonnet-4-5",
    "stages:",
    ...parent("left", opts.leftOut),
    ...parent("right", opts.rightOut),
    "  - id: merge",
    "    system_prompt: Join",
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "          required: [area_id]",
    "          properties:",
    "            area_id:",
    "              type: string",
    "      output:",
    "        schema:",
    "          type: object",
    "",
  ].join("\n");
}

const requiredString = (name: string) => [
  "type: object",
  `required: [${name}]`,
  "properties:",
  `  ${name}:`,
  "    type: string",
];

const STORY_SLICE = [
  "  story-slice:",
  "    type: object",
  "    required: [title]",
  "    properties:",
  "      title:",
  "        type: string",
].join("\n");

describe("io $ref and sequential compatibility", () => {
  it("compiles #/schemas/story-slice on input and output from pipeline schemas", async () => {
    const root = await writeTempFiles({
      "demo.pipeline.yaml": [
        "id: demo",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: produce",
        "    entry: true",
        "    route:",
        "      - to: consume",
        "    system_prompt: Produce",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "  - id: consume",
        "    system_prompt: Consume",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => compilePayloadSchema(outcome.value.stages[0]?.payload_schema)).not.toThrow();
    expect(() =>
      compilePayloadSchema(outcome.value.stages[1]?.clone_input_schema),
    ).not.toThrow();
    expect(() =>
      compilePayloadSchema(outcome.value.stages[1]?.payload_schema),
    ).not.toThrow();
  });

  it("resolves $ref on a uses: stage file after pipeline schemas attach", async () => {
    const root = await writeTempFiles({
      "produce.yaml": [
        "id: produce",
        "system_prompt: Produce",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: produce",
        "    uses: ./produce.yaml",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => compilePayloadSchema(outcome.value.stages[0]?.payload_schema)).not.toThrow();
  });

  it("fails load on a $ref cycle", async () => {
    const root = await writeTempFiles({
      "cycle.pipeline.yaml": [
        "id: cycle",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        "  a:",
        "    $ref: '#/schemas/b'",
        "  b:",
        "    $ref: '#/schemas/a'",
        "stages:",
        "  - id: loop",
        "    system_prompt: Loop",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/a'",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("cycle.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/\$ref cycle/i);
  });


  it("fails pipeline.io_incompatible when consumer required field is missing from producer", async () => {
    const root = await writeTempFiles({
      "incompat.pipeline.yaml": ioPipeline({
        id: "incompat",
        producerOut: requiredString("verdict"),
        consumerIn: requiredString("missing_field"),
      }),
    });
    const outcome = await loadPipelineOutcome("incompat.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain("pipeline.io_incompatible");
  });

  it("loads when the producer output satisfies the consumer input", async () => {
    const root = await writeTempFiles({
      "compat.pipeline.yaml": ioPipeline({
        id: "compat",
        producerOut: [...requiredString("title"), "  extra:", "    type: string"],
        consumerIn: requiredString("title"),
      }),
    });
    const outcome = await loadPipelineOutcome("compat.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
  });


  it("does not treat string-equal $ref as compatible when resolved shapes are not a subset", async () => {
    const root = await writeTempFiles({
      "shared-ref.pipeline.yaml": [
        "id: shared-ref",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        "  produced:",
        "    type: object",
        "    required: [title]",
        "    properties:",
        "      title:",
        "        type: string",
        "  consumed:",
        "    type: object",
        "    required: [title, extra]",
        "    properties:",
        "      title:",
        "        type: string",
        "      extra:",
        "        type: string",
        "stages:",
        "  - id: produce",
        "    entry: true",
        "    route:",
        "      - to: consume",
        "    system_prompt: Produce",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/produced'",
        "  - id: consume",
        "    system_prompt: Consume",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: '#/schemas/consumed'",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("shared-ref.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.io_incompatible")).toBe(
      true,
    );
  });


  it.each([
    {
      name: "rejects a join when child io.input is not a subset of each parent",
      leftOut: requiredString("foo"),
      rightOut: requiredString("bar"),
      ok: false,
    },
    {
      name: "accepts a join when child io.input is a subset of each parent output",
      leftOut: requiredString("area_id"),
      rightOut: requiredString("area_id"),
      ok: true,
    },
  ])("multi-parent join $name", async ({ leftOut, rightOut, ok }) => {
    const root = await writeTempFiles({
      "join.pipeline.yaml": joinPipeline({ id: "join", leftOut, rightOut }),
    });
    const outcome = await loadPipelineOutcome("join.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(ok);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain("pipeline.io_incompatible");
  });


  it("fails isolated stage $ref-only schema with stage.unresolved_schema_ref", async () => {
    const root = await writeTempFiles({
      "ref-only.yaml": [
        "id: ref-only",
        "system_prompt: Isolated",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  input:",
        "    schema:",
        "      type: object",
        "  output:",
        "    schema:",
        "      $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
    });
    const outcome = await loadStageOutcome(path.join(root, "ref-only.yaml"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.unresolved_schema_ref");
  });

  it("fails load when an include fragment declares schemas", async () => {
    const root = await writeTempFiles({
      "fragments/extra.yaml": [
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: gate",
        "    system_prompt: Gate",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "    entry: true",
        "    route:",
        "      - to: finish",
        "",
      ].join("\n"),
      "main.pipeline.yaml": [
        "id: include-schemas",
        "model: anthropic/claude-sonnet-4-5",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages:",
        "  - id: finish",
        "    system_prompt: Finish",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome(path.join(root, "main.pipeline.yaml"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/schemas/);
  });
});

describe("forward route if eq", () => {
  it("loads a legal top-level required field with if eq and no pipeline.route_if_invalid", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-eq"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_all_gated"),
    ).toBe(false);
    const byId = new Map(outcome.value.dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("page")?.needsEdges).toEqual([
      {
        id: "triage",
        on: ["succeeded"],
        if: { field: "severity", op: "eq", value: "high" },
      },
    ]);
    expect(byId.get("notify")?.needsEdges).toEqual([
      { id: "triage", on: ["succeeded"] },
    ]);
  });

  it.each([
    ["route-if-unknown-field", "triage"],
    ["route-if-optional-field", "triage"],
    ["route-if-unknown-op", "triage"],
    ["route-if-missing-value", "triage"],
    ["route-if-extra-keys", "triage"],
    ["route-if-gt-on-string", "triage"],
    ["route-if-empty-in", "triage"],
    ["route-if-in-wrong-type", "triage"],
    ["route-if-array-index", "triage"],
    ["route-if-nested-optional", "triage"],
    ["route-if-ref-optional", "triage"],
    ["route-if-empty-all", "triage"],
    ["route-if-on-loop", "review"],
    ["route-if-on-failed", "run-tests"],
  ] as const)(
    "%s reports pipeline.route_if_invalid not dag_error",
    async (fixture, stageId) => {
      const outcome = await loadPipelineOutcome(pipelinePath(fixture));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(
        false,
      );
      const issue = outcome.issues.find(
        (item) => item.code === "pipeline.route_if_invalid",
      );
      expect(issue).toMatchObject({
        code: "pipeline.route_if_invalid",
        category: "pipeline",
        pipelineId: fixture,
        stageId,
      });

      const validated = await loadPipelineValidated(pipelinePath(fixture), {
        validateStages: false,
      });
      expect(validated.ok).toBe(false);
      const finding = validated.findings.find(
        (item) => item.code === "pipeline.route_if_invalid",
      );
      expect(finding).toMatchObject({
        severity: "error",
        code: "pipeline.route_if_invalid",
        pipelineId: fixture,
        stageId,
      });
    },
  );

  it("loads remaining operators without pipeline.route_if_invalid", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-ops"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
  });

  it.each([
    ["route-if-all-gated", "triage"],
    ["route-if-all-gated-loop", "review"],
  ] as const)(
    "%s warns pipeline.route_all_gated with ok true",
    async (fixture, stageId) => {
      const outcome = await loadPipelineOutcome(pipelinePath(fixture));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const issue = (outcome.issues ?? []).find(
        (item) => item.code === "pipeline.route_all_gated",
      );
      expect(issue).toMatchObject({
        code: "pipeline.route_all_gated",
        category: "pipeline",
        pipelineId: fixture,
        stageId,
      });

      const result = await validatePipeline(pipelinePath(fixture), {
        validateStages: false,
      });
      expect(result.ok).toBe(true);
      const finding = result.findings.find(
        (item) => item.code === "pipeline.route_all_gated",
      );
      expect(finding).toMatchObject({
        severity: "warning",
        code: "pipeline.route_all_gated",
        pipelineId: fixture,
        stageId,
      });

      const strict = await validatePipeline(pipelinePath(fixture), {
        validateStages: false,
        strict: true,
      });
      expect(strict.ok).toBe(true);
      expect(strict.summary.errors).toBe(0);
      expect(
        strict.findings.some(
          (item) =>
            item.code === "pipeline.route_all_gated" && item.severity === "warning",
        ),
      ).toBe(true);
    },
  );

  it("loads on: [failed] without if", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(REPO_ROOT, "examples/route-wiring-smoke-test/02-on-gating.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
  });

  it.each(["route-if-duplicate-to", "route-cycle", "route-loop-unknown-key"])(
    "%s stays pipeline.dag_error, not route_if_invalid",
    async (fixture) => {
      const outcome = await loadPipelineOutcome(pipelinePath(fixture));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      const codes = outcome.issues.map((issue) => issue.code);
      expect(codes).toContain("pipeline.dag_error");
      expect(codes).not.toContain("pipeline.route_if_invalid");
    },
  );
});
