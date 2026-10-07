import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { compileTargetContract } from "../src/config/yamlDialect.js";

const ACTION_MODEL = [
  "    system_prompt: Do work",
  "    model: anthropic/claude-sonnet-4-5",
];

const INLINE_IO = [
  "    io:",
  "      input:",
  "        schema:",
  "          type: object",
  "      output:",
  "        schema:",
  "          type: object",
];

const FILE_IO = [
  "io:",
  "  input:",
  "    schema:",
  "      type: object",
  "  output:",
  "    schema:",
  "      type: object",
];

async function writeTempCatalog(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-dual-read-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

function inlinePipeline(id: string, bodyLines: string[]): string {
  return ["id: " + id, "stages:", "  - id: plan", ...ACTION_MODEL, ...bodyLines, ""].join("\n");
}

async function loadInline(bodyLines: string[], id = "demo") {
  const root = await writeTempCatalog({
    "demo.pipeline.yaml": inlinePipeline(id, bodyLines),
  });
  return loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
}

function issuesOf(outcome: { ok: boolean; issues?: { code: string; message: string }[] }) {
  expect(outcome.ok).toBe(false);
  return outcome.issues ?? [];
}

const REPAIR_ENTRY = [
  "    on_verify_fail:",
  "      mode: repair",
  "      max_attempts: 2",
  "      retry_safety: idempotent",
];

describe("YAML dual-read dialect", () => {
  it("compileTargetContract returns typed emit/after/recovery without stamping the source record", () => {
    const raw: Record<string, unknown> = {
      io: {
        input: { schema: { type: "object" } },
        output: {
          schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      },
      verify: [
        { id: "approved", type: "gate", kind: "confirm", when: ["emit"] },
        { id: "report", type: "artifact", path: "report.md", when: ["after"] },
      ],
      on_verify_fail: {
        mode: "repair",
        max_attempts: 2,
        retry_safety: "idempotent",
      },
    };
    const compiled = compileTargetContract(raw, {
      stageId: "plan",
      label: "plan",
      category: "pipeline",
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.payload_schema).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    });
    expect(compiled.value.clone_input_schema).toEqual({ type: "object" });
    expect(compiled.value.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(compiled.value.completion).toEqual({
      mode: "all",
      checks: [{ id: "report", type: "artifact", path: "report.md" }],
    });
    expect(compiled.value.recovery).toEqual({
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });
    expect(raw.payload_schema).toBeUndefined();
    expect(raw.clone_input_schema).toBeUndefined();
    expect(raw.pre_emit_checks).toBeUndefined();
    expect(raw.completion).toBeUndefined();
    expect(raw.recovery).toBeUndefined();
  });

  it("loads uses plus on_verify_fail and rejects uses plus io", async () => {
    const root = await writeTempCatalog({
      "worker.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        ...FILE_IO,
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
        ...REPAIR_ENTRY,
        "",
      ].join("\n"),
      "conflict.pipeline.yaml": [
        "id: conflict",
        "stages:",
        "  - id: worker",
        "    uses: ./worker.yaml",
        ...INLINE_IO,
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
    expect(issuesOf(conflict)[0]?.code).toBe("pipeline.stage_uses_inline_conflict");
  });

  describe("on_verify_fail without resolved after-phase checks", () => {
    const WORKER_HEAD = [
      "id: worker",
      "system_prompt: Do work",
      "model: anthropic/claude-sonnet-4-5",
    ];
    const USES_PIPELINE = [
      "id: demo",
      "stages:",
      "  - id: worker",
      "    uses: ./worker.yaml",
      ...REPAIR_ENTRY,
      "",
    ].join("\n");

    it.each([
      {
        name: "uses a stage file with only emit-phase verify",
        worker: [
          ...WORKER_HEAD,
          "gate_kinds: [confirm]",
          ...FILE_IO,
          "verify:",
          "  - id: approved",
          "    type: gate",
          "    kind: confirm",
          "    when: [emit]",
          "",
        ],
      },
      { name: "uses a stage file with no verify", worker: [...WORKER_HEAD, ...FILE_IO, ""] },
    ])("rejects when the entry $name", async ({ worker }) => {
      const root = await writeTempCatalog({
        "worker.yaml": worker.join("\n"),
        "demo.pipeline.yaml": USES_PIPELINE,
      });
      const issues = issuesOf(await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root }));
      expect(issues[0]?.code).toBe("pipeline.invalid_recovery");
      expect(issues[0]?.message).toMatch(/requires a completion contract/);
    });

    it("rejects inline on_verify_fail when verify is emit-phase only", async () => {
      const issues = issuesOf(
        await loadInline([
          "    gate_kinds: [confirm]",
          ...INLINE_IO,
          "    verify:",
          "      - id: approved",
          "        type: gate",
          "        kind: confirm",
          "        when: [emit]",
          ...REPAIR_ENTRY,
        ]),
      );
      expect(issues[0]?.code).toBe("pipeline.invalid_recovery");
      expect(issues[0]?.message).toMatch(/requires a completion contract/);
    });
  });

  it.each([
    {
      name: "payload_schema and io.output on one entry",
      body: [
        "    payload_schema:",
        "      type: object",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
      ],
    },
    {
      name: "completion and verify in one file",
      body: [
        ...INLINE_IO,
        "    verify:",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "    completion:",
        "      checks:",
        "        - id: tests",
        "          type: command",
        "          run: npm test",
      ],
    },
  ])("rejects mixed $name with catalog.mixed_yaml_dialect", async ({ body }) => {
    const issues = issuesOf(await loadInline(body, "mixed"));
    expect(issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")).toBe(true);
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
        "clone_input_schema:",
        "  type: object",
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
        ...FILE_IO,
        "",
      ].join("\n"),
      "second.yaml": [
        "id: second",
        "system_prompt: Do more",
        "model: anthropic/claude-sonnet-4-5",
        ...FILE_IO,
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

  it("rejects unknown pipeline-entry keys", async () => {
    const issues = issuesOf(await loadInline(["    label: bad", ...INLINE_IO], "unknown"));
    expect(issues[0]?.code).toBe("pipeline.invalid_shape");
    expect(issues[0]?.message).toMatch(/unknown key "label"/);
  });

  it("rejects wiring keys on a new-dialect stage file and ignores them on legacy files", async () => {
    const root = await writeTempCatalog({
      "target.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        ...FILE_IO,
        "needs: other",
        "",
      ].join("\n"),
      "legacy.yaml": [
        "id: worker",
        "system_prompt: Do work",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: object",
        "clone_input_schema:",
        "  type: object",
        "needs: other",
        "",
      ].join("\n"),
    });
    const target = await loadStageOutcome(path.join(root, "target.yaml"));
    const targetIssues = issuesOf(target);
    expect(targetIssues[0]?.code).toBe("stage.invalid_shape");
    expect(targetIssues[0]?.message).toMatch(/needs/);

    const legacy = await loadStageOutcome(path.join(root, "legacy.yaml"));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.value.payload_schema).toMatchObject({ type: "object" });
  });

  it.each([
    {
      name: "type: command with when: [emit]",
      body: [
        ...INLINE_IO,
        "    verify:",
        "      - id: tests",
        "        type: command",
        "        run: npm test",
        "        when: [emit]",
      ],
      code: "pipeline.invalid_verify",
      message: /cannot use when: emit/,
    },
    {
      name: "type: artifact with omitted when",
      body: [
        ...INLINE_IO,
        "    verify:",
        "      - id: report",
        "        type: artifact",
        "        path: report.md",
      ],
      code: "pipeline.invalid_verify",
      message: /type artifact requires when/,
    },
    {
      name: "an emit-default gate whose kind is missing from gate_kinds",
      body: [
        ...INLINE_IO,
        "    verify:",
        "      - id: approved",
        "        type: gate",
        "        kind: confirm",
      ],
      message: /gate check "approved" requires gate_kinds to include "confirm"/,
    },
    {
      name: "omitted io on an inline stage",
      body: [],
      code: "stage.invalid_io",
      message: /io is required/,
    },
    {
      name: "omitted io.input.schema",
      body: ["    io:", "      output:", "        schema:", "          type: object"],
      code: "stage.invalid_io",
      message: /io\.input\.schema is required/,
    },
    {
      name: "omitted io.output.schema",
      body: ["    io:", "      input:", "        schema:", "          type: object"],
      code: "stage.invalid_io",
      message: /io\.output\.schema is required/,
    },
    {
      name: "an io side without schema",
      body: [
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output: {}",
      ],
      code: "stage.invalid_io",
      message: /io\.output\.schema is required/,
    },
  ])("rejects $name", async ({ body, code, message }) => {
    const issues = issuesOf(await loadInline(body, "bad"));
    if (code) expect(issues[0]?.code).toBe(code);
    expect(issues[0]?.message).toMatch(message);
  });

  it("maps type: artifact when: [emit, after] onto emit basename and after nonempty path", async () => {
    const outcome = await loadInline([
      ...INLINE_IO,
      "    verify:",
      "      - id: report",
      "        type: artifact",
      "        basename: report.md",
      "        when: [emit, after]",
    ]);
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
    const afterArtifact = (extra: string[]) => [
      ...INLINE_IO,
      "    verify:",
      "      - id: report",
      "        type: artifact",
      "        path: report.md",
      ...extra,
      "        when: [after]",
    ];
    const omitted = await loadInline(afterArtifact([]));
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    expect(omitted.value.dag.nodes[0]?.completion?.checks[0]).toEqual({
      id: "report",
      type: "artifact",
      path: "report.md",
    });
    const explicit = await loadInline(afterArtifact(["        nonempty: false"]));
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.dag.nodes[0]?.completion?.checks[0]).toEqual({
      id: "report",
      type: "artifact",
      path: "report.md",
      nonempty: false,
    });
  });

  it("maps verify phases: omitted when defaults gate to emit and command to after; after-only checks stay out of pre_emit_checks", async () => {
    const outcome = await loadInline([
      "    gate_kinds: [confirm]",
      ...INLINE_IO,
      "    verify:",
      "      - id: approved",
      "        type: gate",
      "        kind: confirm",
      "      - id: tests",
      "        type: command",
      "        run: npm test",
      "      - id: files",
      "        type: checkout_changes",
      "        when: [after]",
      "      - id: list",
      "        type: checklist",
      "        items: [done]",
      "        when: [after]",
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.payload_schema).toEqual({ type: "object" });
    expect(outcome.value.stages[0]?.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(outcome.value.dag.nodes[0]?.completion).toEqual({
      mode: "all",
      checks: [
        { id: "tests", type: "command", run: "npm test" },
        { id: "files", type: "checkout_changes" },
        { id: "list", type: "checklist", items: ["done"] },
      ],
    });
    expect(outcome.issues?.some((issue) => issue.code === "catalog.legacy_yaml")).toBeFalsy();
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
        "    payload_schema:",
        "      type: object",
        "    clone_input_schema:",
        "      type: object",
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
        ...INLINE_IO,
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
