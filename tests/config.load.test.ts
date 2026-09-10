import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, taskPath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines } from "../src/config/listConfig.js";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStage, loadStageOutcome } from "../src/config/loadStage.js";
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

  it("loads the diamond fan-in fixture with two inbound synthesize edges", async () => {
    const loaded = await loadPipeline(pipelinePath("diamond-fan-in"), { cwd: fixtures });
    expect(loaded.pipeline.stages).toEqual([
      "clarify",
      "research",
      "validation",
      "synthesize",
    ]);
    expect(loaded.dag.roots).toEqual(["clarify"]);
    expect(loaded.dag.childrenOf.research).toEqual(["synthesize"]);
    expect(loaded.dag.childrenOf.validation).toEqual(["synthesize"]);
    const synthesize = loaded.dag.nodes.find((node) => node.id === "synthesize");
    expect(synthesize).toMatchObject({
      needs: null,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
      ancestors: ["clarify", "research", "validation"],
    });
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

  it("preserves empty gate_kinds as [] rather than omitting (KTD1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-gate-kinds-empty-"));
    const emptyKinds = path.join(dir, "no-hitl.yaml");
    await writeFile(
      emptyKinds,
      [
        "id: no-hitl",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds: []",
        "",
      ].join("\n"),
    );
    const loaded = await loadStage(emptyKinds);
    expect(loaded.gate_kinds).toEqual([]);
    expect(loaded.gate_kinds).not.toBeUndefined();
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

  it("loads declared pre_emit_checks from stage YAML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-pre-emit-checks-"));
    const withChecks = path.join(dir, "with-checks.yaml");
    await writeFile(
      withChecks,
      [
        "id: approve-plan",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds: [artifact_backed]",
        "pre_emit_checks:",
        "  - id: plan-approved",
        "    type: gate",
        "    kind: artifact_backed",
        "  - id: plan-artifact-present",
        "    type: artifact_declared",
        "    basename: implementation-plan.md",
        "",
      ].join("\n"),
    );
    const loaded = await loadStage(withChecks);
    expect(loaded.pre_emit_checks).toEqual([
      { id: "plan-approved", type: "gate", kind: "artifact_backed" },
      {
        id: "plan-artifact-present",
        type: "artifact_declared",
        basename: "implementation-plan.md",
      },
    ]);

    const withoutChecks = path.join(dir, "without-checks.yaml");
    await writeFile(
      withoutChecks,
      ["id: no-checks", "system_prompt: x", "model: anthropic/claude-sonnet-4-5", ""].join(
        "\n",
      ),
    );
    const loadedWithout = await loadStage(withoutChecks);
    expect(loadedWithout.pre_emit_checks).toBeUndefined();
  });

  it("rejects invalid pre_emit_checks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-pre-emit-checks-bad-"));
    const emptyArray = path.join(dir, "empty.yaml");
    await writeFile(
      emptyArray,
      [
        "id: empty",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "pre_emit_checks: []",
        "",
      ].join("\n"),
    );
    await expect(loadStage(emptyArray)).rejects.toThrow(
      /pre_emit_checks must be a non-empty array/,
    );

    const badKind = path.join(dir, "bad-kind.yaml");
    await writeFile(
      badKind,
      [
        "id: bad-kind",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "pre_emit_checks:",
        "  - id: x",
        "    type: gate",
        "    kind: not_a_kind",
        "",
      ].join("\n"),
    );
    await expect(loadStage(badKind)).rejects.toThrow(/\.kind must be one of/);
  });

  it("loads optional clone_input_schema and clone_actions from stage YAML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-clone-fields-"));
    const filePath = path.join(dir, "investigate-area.yaml");
    await writeFile(
      filePath,
      [
        "id: investigate-area",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "clone_input_schema:",
        "  type: object",
        "  properties:",
        "    area_id:",
        "      type: string",
        "    objective:",
        "      type: string",
        "    paths:",
        "      type: array",
        "      items:",
        "        type: string",
        "  required:",
        "    - area_id",
        "    - objective",
        "    - paths",
        "clone_actions:",
        "  - once",
        "  - fanout",
        "",
      ].join("\n"),
    );
    const loaded = await loadStage(filePath);
    expect(loaded.clone_input_schema).toMatchObject({
      type: "object",
      required: ["area_id", "objective", "paths"],
    });
    expect(loaded.clone_actions).toEqual(["once", "fanout"]);
  });

  it("rejects invalid clone_input_schema and empty or non-array clone_actions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-clone-bad-"));
    const badSchema = path.join(dir, "bad-schema.yaml");
    await writeFile(
      badSchema,
      [
        "id: bad-schema",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "clone_input_schema:",
        "  type: not-a-valid-type",
        "",
      ].join("\n"),
    );
    await expect(loadStage(badSchema)).rejects.toThrow(/clone_input_schema/);

    const emptyActions = path.join(dir, "empty-actions.yaml");
    await writeFile(
      emptyActions,
      [
        "id: empty-actions",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "clone_actions: []",
        "",
      ].join("\n"),
    );
    await expect(loadStage(emptyActions)).rejects.toThrow(/clone_actions/);

    const stringAction = path.join(dir, "string-action.yaml");
    await writeFile(
      stringAction,
      [
        "id: string-action",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        'clone_actions: "skip"',
        "",
      ].join("\n"),
    );
    await expect(loadStage(stringAction)).rejects.toThrow(/clone_actions/);

    const unknownAction = path.join(dir, "unknown-action.yaml");
    await writeFile(
      unknownAction,
      [
        "id: unknown-action",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "clone_actions:",
        "  - explode",
        "",
      ].join("\n"),
    );
    await expect(loadStage(unknownAction)).rejects.toThrow(/clone_actions/);
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

  it("leaves mcp undefined when the stage file omits the field", async () => {
    const loaded = await loadStage(path.join(fixtures, "stages", "clarify.yaml"));
    expect(loaded.mcp).toBeUndefined();
  });

  it("loads mcp server names from stage YAML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-"));
    const filePath = path.join(dir, "named.yaml");
    await writeFile(
      filePath,
      [
        "id: named",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "mcp:",
        "  - github",
        "  - notion",
        "",
      ].join("\n"),
    );
    expect((await loadStage(filePath)).mcp).toEqual(["github", "notion"]);
  });

  it("rejects empty, whitespace-only, non-string, mapping, and duplicate mcp names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-bad-"));
    const cases: Array<{ name: string; mcpLines: string }> = [
      { name: "empty", mcpLines: 'mcp:\n  - ""' },
      { name: "whitespace", mcpLines: 'mcp:\n  - "   "' },
      { name: "number", mcpLines: "mcp:\n  - 1" },
      { name: "mapping", mcpLines: "mcp:\n  github: true" },
      { name: "duplicate", mcpLines: "mcp:\n  - github\n  - github" },
    ];
    for (const { name, mcpLines } of cases) {
      const filePath = path.join(dir, `${name}.yaml`);
      await writeFile(
        filePath,
        [
          `id: ${name}`,
          "system_prompt: x",
          "model: anthropic/claude-sonnet-4-5",
          mcpLines,
          "",
        ].join("\n"),
      );
      const outcome = await loadStageOutcome(filePath);
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) return;
      expect(outcome.issues[0]?.code, name).toBe("stage.invalid_mcp");
    }
  });

  it("rejects reserved mcp name stageflow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-reserved-"));
    const filePath = path.join(dir, "reserved.yaml");
    await writeFile(
      filePath,
      [
        "id: reserved",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "mcp:",
        "  - stageflow",
        "",
      ].join("\n"),
    );
    const outcome = await loadStageOutcome(filePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_mcp");
    expect(outcome.issues[0]?.message).toMatch(/stageflow/);
  });

  it("loads optional timeout_ms from stage YAML", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-timeout-ms-"));
    const filePath = path.join(dir, "approve.yaml");
    await writeFile(
      filePath,
      [
        "id: approve",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "timeout_ms: 3600000",
        "",
      ].join("\n"),
    );
    const loaded = await loadStage(filePath);
    expect(loaded.timeout_ms).toBe(3600000);
  });

  it("rejects non-positive timeout_ms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-timeout-ms-bad-"));
    const zero = path.join(dir, "zero.yaml");
    await writeFile(
      zero,
      [
        "id: zero",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "timeout_ms: 0",
        "",
      ].join("\n"),
    );
    await expect(loadStage(zero)).rejects.toThrow(/timeout_ms/);

    const notInt = path.join(dir, "float.yaml");
    await writeFile(
      notInt,
      [
        "id: float",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "timeout_ms: 1.5",
        "",
      ].join("\n"),
    );
    await expect(loadStage(notInt)).rejects.toThrow(/timeout_ms/);
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

async function writeTempCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-dual-read-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

describe("YAML dual-read dialect", () => {
  it("loads an inline target entry with io and verify onto IR fields", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    gate_kinds: [confirm]",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "          properties:",
        "            verdict:",
        "              type: string",
        "          required: [verdict]",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "        when: [emit]",
        "      - id: report",
        "        type: artifact",
        "        path: report.md",
        "        when: [after]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.payload_schema).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    });
    expect(outcome.value.stages[0]?.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(outcome.value.dag.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "report", type: "artifact", path: "report.md", nonempty: true }],
    });
    expect(outcome.issues?.some((issue) => issue.code === "catalog.legacy_yaml")).toBeFalsy();
  });

  it("loads uses plus on_verify_fail and rejects uses plus io", async () => {
    const root = await writeTempCatalog({
      "worker.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "verify:",
        "  - id: self-review",
        "    type: checklist",
        "    items: [Tests pass]",
        "    when: [after]",
        "",
      ].join("\n"),
      "ok.pipeline.yaml": [
        "id: ok",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "    on_verify_fail:",
        "      mode: repair",
        "      max_attempts: 2",
        "      retry_safety: idempotent",
        "",
      ].join("\n"),
      "conflict.pipeline.yaml": [
        "id: conflict",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    });
    const ok = await loadPipelineOutcome("ok.pipeline.yaml", { cwd: root });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.dag.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "self-review", type: "checklist", items: ["Tests pass"] }],
    });
    expect(ok.value.dag.nodes[0]?.recovery).toEqual({
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });

    const conflict = await loadPipelineOutcome("conflict.pipeline.yaml", { cwd: root });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.issues[0]?.code).toBe("pipeline.stage_uses_inline_conflict");
  });

  it("rejects on_verify_fail when resolved after-phase checks are missing", async () => {
    const root = await writeTempCatalog({
      "worker.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds: [confirm]",
        "verify:",
        "  - id: approved",
        "    type: gate",
        "    kind: confirm",
        "    when: [emit]",
        "",
      ].join("\n"),
      "emit-only.pipeline.yaml": [
        "id: emit-only",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "    on_verify_fail:",
        "      mode: repair",
        "      max_attempts: 2",
        "      retry_safety: idempotent",
        "",
      ].join("\n"),
      "bare.pipeline.yaml": [
        "id: bare",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "    on_verify_fail:",
        "      mode: repair",
        "      max_attempts: 2",
        "      retry_safety: idempotent",
        "",
      ].join("\n"),
    });
    const emitOnly = await loadPipelineOutcome("emit-only.pipeline.yaml", { cwd: root });
    expect(emitOnly.ok).toBe(false);
    if (emitOnly.ok) return;
    expect(emitOnly.issues[0]?.code).toBe("pipeline.invalid_recovery");
    expect(emitOnly.issues[0]?.message).toMatch(/requires a completion contract/);

    await writeFile(
      path.join(root, "worker.yaml"),
      [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    );
    const bare = await loadPipelineOutcome("bare.pipeline.yaml", { cwd: root });
    expect(bare.ok).toBe(false);
    if (bare.ok) return;
    expect(bare.issues[0]?.code).toBe("pipeline.invalid_recovery");
    expect(bare.issues[0]?.message).toMatch(/requires a completion contract/);
  });

  it("rejects mixed payload_schema and io.output on one entry", async () => {
    const root = await writeTempCatalog({
      "mixed.pipeline.yaml": [
        "id: mixed",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    payload_schema:",
        "      type: object",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("mixed.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")).toBe(
      true,
    );
  });

  it("loads a target pipeline that uses a legacy stage file", async () => {
    const root = await writeTempCatalog({
      "worker.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: object",
        "  properties:",
        "    verdict:",
        "      type: string",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.payload_schema).toMatchObject({ type: "object" });
    expect(outcome.value.dag.nodes[0]?.recovery).toBeUndefined();
  });

  it("treats a uses-only entry as dialect-neutral with no catalog.legacy_yaml", async () => {
    const root = await writeTempCatalog({
      "first.yaml": [
        "id: first",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "second.yaml": [
        "id: second",
        "system_prompt: Do more",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: first",
        "    uses: ./first.yaml",
        "  - id: second",
        "    uses: ./second.yaml",
        "    needs: [first]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.stages).toEqual(["first", "second"]);
    expect(outcome.issues?.some((issue) => issue.code === "catalog.legacy_yaml")).toBeFalsy();
  });

  it("loads needs: [single-parent] on a target inline successor", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: clarify",
        "    system_prompt: Clarify",
        "    model: anthropic/claude-sonnet-4-5",
        "  - id: design-doc",
        "    system_prompt: Design",
        "    model: anthropic/claude-sonnet-4-5",
        "    needs: [clarify]",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const design = outcome.value.dag.nodes.find((node) => node.id === "design-doc");
    expect(design).toMatchObject({
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
    });
  });

  it("rejects mixed completion and verify in one file", async () => {
    const root = await writeTempCatalog({
      "mixed.pipeline.yaml": [
        "id: mixed",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "    completion:",
        "      checks:",
        "        - id: tests",
        "          type: command",
        "          run: npm test",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("mixed.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")).toBe(
      true,
    );
  });

  it("rejects unknown pipeline-entry keys", async () => {
    const root = await writeTempCatalog({
      "unknown.pipeline.yaml": [
        "id: unknown",
        "stages:",
        "  - id: plan",
        "    label: bad",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("unknown.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_shape");
    expect(outcome.issues[0]?.message).toMatch(/unknown key "label"/);
  });

  it("rejects wiring keys on a new-dialect stage file and ignores them on legacy files", async () => {
    const root = await writeTempCatalog({
      "target.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  output:",
        "    schema:",
        "      type: object",
        "needs: other",
        "",
      ].join("\n"),
      "legacy.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: object",
        "needs: other",
        "",
      ].join("\n"),
    });
    const target = await loadStageOutcome(path.join(root, "target.yaml"));
    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.issues[0]?.code).toBe("stage.invalid_shape");
    expect(target.issues[0]?.message).toMatch(/needs/);

    const legacy = await loadStageOutcome(path.join(root, "legacy.yaml"));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.value.payload_schema).toMatchObject({ type: "object" });
  });

  it("rejects type: command with when: [emit]", async () => {
    const root = await writeTempCatalog({
      "bad.pipeline.yaml": [
        "id: bad",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "        when: [emit]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("bad.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.invalid_verify")).toBe(
      true,
    );
    expect(outcome.issues[0]?.message).toMatch(/cannot use when: emit/);
  });

  it("rejects new-dialect type: artifact with omitted when", async () => {
    const root = await writeTempCatalog({
      "bad.pipeline.yaml": [
        "id: bad",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        path: report.md",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("bad.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.invalid_verify")).toBe(
      true,
    );
    expect(outcome.issues[0]?.message).toMatch(/type artifact requires when/);
  });

  it("defaults omitted when: gate to emit and command to after", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    gate_kinds: [confirm]",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(outcome.value.dag.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "tests", type: "command", run: "npm test" }],
    });
  });

  it("maps type: artifact when: [emit, after] onto emit basename and after nonempty path", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        basename: report.md",
        "        when: [emit, after]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.pre_emit_checks).toEqual([
      { id: "report", type: "artifact_declared", basename: "report.md" },
    ]);
    expect(outcome.value.dag.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "report", type: "artifact", path: "report.md", nonempty: true }],
    });
  });

  it("does not put after-only checks into pre_emit_checks", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    gate_kinds: [confirm]",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "        when: [emit]",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "        when: [after]",
        "      - id: files",
        "        type: checkout_changes",
        "        when: [after]",
        "      - id: list",
        "        type: checklist",
        "        items: [done]",
        "        when: [after]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(outcome.value.dag.nodes[0]?.completion?.checks.map((check) => check.type)).toEqual([
      "command",
      "checkout_changes",
      "checklist",
    ]);
  });

  it("loads equivalent runner inputs from legacy pre_emit_checks + completion and a verify list", async () => {
    const root = await writeTempCatalog({
      "legacy.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    gate_kinds: [confirm]",
        "    pre_emit_checks:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "      - id: report",
        "        type: artifact_declared",
        "        basename: report.md",
        "    completion:",
        "      checks:",
        "        - id: tests",
        "          type: command",
        "          run: npm test",
        "        - id: report-file",
        "          type: artifact",
        "          path: report.md",
        "          nonempty: true",
        "",
      ].join("\n"),
      "target.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    gate_kinds: [confirm]",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "        when: [emit]",
        "      - id: report",
        "        type: artifact",
        "        basename: report.md",
        "        when: [emit]",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "        when: [after]",
        "      - id: report-file",
        "        type: artifact",
        "        path: report.md",
        "        nonempty: true",
        "        when: [after]",
        "",
      ].join("\n"),
    });
    const legacy = await loadPipelineOutcome("legacy.pipeline.yaml", { cwd: root });
    const target = await loadPipelineOutcome("target.pipeline.yaml", { cwd: root });
    expect(legacy.ok).toBe(true);
    expect(target.ok).toBe(true);
    if (!legacy.ok || !target.ok) return;
    expect(target.value.stages[0]?.pre_emit_checks).toEqual(
      legacy.value.stages[0]?.pre_emit_checks,
    );
    expect(target.value.dag.nodes[0]?.completion).toEqual(
      legacy.value.dag.nodes[0]?.completion,
    );
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
