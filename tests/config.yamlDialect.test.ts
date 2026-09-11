import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";

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
      checks: [{ id: "report", type: "artifact", path: "report.md" }],
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

  it("rejects inline on_verify_fail when verify is emit-phase only", async () => {
    const root = await writeTempCatalog({
      "emit-only.pipeline.yaml": [
        "id: emit-only",
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
        "    on_verify_fail:",
        "      mode: repair",
        "      max_attempts: 2",
        "      retry_safety: idempotent",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("emit-only.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_recovery");
    expect(outcome.issues[0]?.message).toMatch(/requires a completion contract/);
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
        "    entry: true",
        "    route:",
        "      - to: second",
        "  - id: second",
        "    uses: ./second.yaml",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.stages).toEqual(["first", "second"]);
    expect(outcome.issues?.some((issue) => issue.code === "catalog.legacy_yaml")).toBeFalsy();
  });

  it("loads route: [{ to: single-child }] on a target inline predecessor", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: clarify",
        "    system_prompt: Clarify",
        "    model: anthropic/claude-sonnet-4-5",
        "    entry: true",
        "    route:",
        "      - to: design-doc",
        "  - id: design-doc",
        "    system_prompt: Design",
        "    model: anthropic/claude-sonnet-4-5",
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
      checks: [{ id: "report", type: "artifact", path: "report.md" }],
    });
  });

  it("keeps after-artifact nonempty only when the YAML boolean is present", async () => {
    const root = await writeTempCatalog({
      "omit.pipeline.yaml": [
        "id: omit",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        path: report.md",
        "        when: [after]",
        "",
      ].join("\n"),
      "false.pipeline.yaml": [
        "id: nonempty-false",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        path: report.md",
        "        nonempty: false",
        "        when: [after]",
        "",
      ].join("\n"),
    });
    const omitted = await loadPipelineOutcome("omit.pipeline.yaml", { cwd: root });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    expect(omitted.value.dag.nodes[0]?.completion?.checks[0]).toEqual({
      id: "report",
      type: "artifact",
      path: "report.md",
    });
    const explicit = await loadPipelineOutcome("false.pipeline.yaml", { cwd: root });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.dag.nodes[0]?.completion?.checks[0]).toEqual({
      id: "report",
      type: "artifact",
      path: "report.md",
      nonempty: false,
    });
  });

  it("fails load when emit-default verify gate kind is missing from gate_kinds", async () => {
    const root = await writeTempCatalog({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: anthropic/claude-sonnet-4-5",
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /gate check "approved" requires gate_kinds to include "confirm"/,
    );
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
