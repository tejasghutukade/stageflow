import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidateCommand } from "../src/cli/validateCommand.js";
import { createDraftPackage } from "../src/config/draftPackage.js";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import {
  parseFunctionDefinition,
  parseFunctionJs,
  parseFunctionYaml,
  serializeFunctionDefinition,
  serializeFunctionJsFile,
} from "../src/config/loadFunction.js";
import { catalogFileKind, writeCatalogFileForHttp } from "../src/server/readCatalogFile.js";
import { AgentService } from "../src/agents/service.js";
import { AgentStore } from "../src/agents/store.js";
import { FunctionError, FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";

const SOURCE = "export default function execute(context) {\n  return { passed: true };\n}\n";
const ACTOR = { source: "api" as const, author: "test" };

const fileCapability = {
  id: "report",
  type: "file" as const,
  root: "artifacts" as const,
  path: "report.json",
  access: "read" as const,
};

const apiCapability = {
  id: "scores",
  type: "api" as const,
  origin: "https://scores.example",
  methods: ["GET"],
  path_prefix: "/v1",
  effect: "read" as const,
  credential_ref: "scores",
};

function verification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Function ${id}`,
    description: "Checks a report",
    kind: "verification",
    source: SOURCE,
    capabilities: [fileCapability],
    bindings: [],
    ...overrides,
  };
}

function toolDefinition(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Tool ${id}`,
    kind: "tool",
    source: SOURCE,
    tool_name: "lookup_score",
    tool_description: "Look up a score by id",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Score id" } },
      required: ["id"],
    },
    capabilities: [apiCapability, fileCapability],
    bindings: [],
    ...overrides,
  };
}

const fileGrant = { id: "report", root: "artifacts", path: "report.json" };
const apiGrant = {
  id: "scores",
  origin: "https://scores.example",
  methods: ["GET"],
  path_prefix: "/v1",
  credential_ref: "scores",
};

function stageBody(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    system_prompt: `Stage ${id}`,
    io: {
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
    },
    ...extra,
  };
}

describe("function catalog", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function open() {
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-fn-project-"));
    dirs.push(home, project);
    const clock = { now: new Date("2026-11-11T12:00:00.000Z") };
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({
      store: new FunctionStore(connection),
      now: () => clock.now,
    });
    const agents = new AgentService({ store: new AgentStore(connection), now: () => clock.now });
    return { project, clock, service, agents };
  }

  it("creates, edits, duplicates, and deletes an unreferenced function", async () => {
    const { project, clock, service } = await open();
    const created = await service.create(project, verification("score"), ACTOR);
    expect(created.id).toBe("score");
    expect(created.revision).toBe(1);
    expect(created.definition?.timeout_ms).toBe(5000);
    expect(created.contractVersion).toBe(1);
    expect(created.sourceHash).toBe(createHash("sha256").update(SOURCE).digest("hex"));
    const onDisk = await readFile(path.join(project, "functions", "score.function.js"), "utf8");
    expect(onDisk).toContain("id: score");

    clock.now = new Date("2026-11-11T13:00:00.000Z");
    const edited = await service.save(
      project,
      "score",
      {
        baseRevision: 1,
        definition: verification("score", { description: "Updated" }),
        summary: "Tighten the check",
      },
      ACTOR,
    );
    expect(edited.id).toBe("score");
    expect(edited.revision).toBe(2);
    expect(edited.createdAt).toBe(created.createdAt);
    expect(edited.updatedAt).not.toBe(created.updatedAt);
    expect(edited.definition?.description).toBe("Updated");

    const copy = await service.duplicate(project, "score", { id: "score_copy" }, ACTOR);
    expect(copy.id).toBe("score_copy");
    expect(copy.revision).toBe(1);
    expect(copy.definition?.description).toBe("Updated");
    expect(await service.listRevisions(project, "score_copy")).toHaveLength(1);

    const originalAfterCopy = await service.save(
      project,
      "score",
      { baseRevision: 2, definition: verification("score", { description: "Original only" }) },
      ACTOR,
    );
    expect(originalAfterCopy.revision).toBe(3);
    expect((await service.getRevision(project, "score_copy", 1)).definition.description).toBe("Updated");
    expect(await service.listRevisions(project, "score")).toHaveLength(3);

    await service.delete(project, "score_copy");
    await expect(service.get(project, "score_copy")).rejects.toMatchObject({ code: "function.not_found" });
    expect((await service.getRevision(project, "score_copy", 1)).definition.id).toBe("score_copy");
    expect((await service.list(project)).map((row) => row.id)).toEqual(["score"]);
  });

  it("rejects a routing function attached as a tool and a missing id", async () => {
    const { project, service } = await open();
    await service.create(project, verification("route_fn", { kind: "routing", bindings: [] }), ACTOR);
    const asTool = await service.attachmentIssues(project, [
      { kind: "tool", id: "route_fn", grants: [fileGrant] },
    ]);
    expect(asTool).toEqual([
      expect.objectContaining({ code: "function.kind_mismatch", path: "route_fn" }),
    ]);
    const missing = await service.attachmentIssues(project, [
      { kind: "verification", id: "missing_fn", grants: [] },
    ]);
    expect(missing).toEqual([
      expect.objectContaining({ code: "function.missing", path: "missing_fn" }),
    ]);

    const pipeline = [
      "id: demo",
      "model: anthropic/claude-sonnet-4-5",
      "stages:",
      "  - id: check",
      "    system_prompt: Check.",
      "    model: anthropic/claude-sonnet-4-5",
      "    io:",
      "      input:",
      "        schema:",
      "          type: object",
      "      output:",
      "        schema:",
      "          type: object",
      "    verify:",
      "      - id: score",
      "        type: function",
      "        function: missing_fn",
      "        grants: []",
      "",
    ].join("\n");
    await writeFile(path.join(project, "demo.pipeline.yaml"), pipeline);
    const loaded = await loadPipelineOutcome(path.join(project, "demo.pipeline.yaml"), {
      cwd: project,
      projectRoot: project,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "function.missing" })]),
    );

    const logs: string[] = [];
    const code = await runValidateCommand(["--pipeline", "demo.pipeline.yaml", "--json"], {
      cwd: project,
      projectRoot: project,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(code).toBe(1);
    const payload = JSON.parse(logs.join("\n")) as { findings: Array<{ code: string; file: string; message: string; severity: string; category: string }> };
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "function.missing",
          severity: "error",
          category: expect.any(String),
          file: expect.any(String),
          message: expect.stringContaining("missing_fn"),
        }),
      ]),
    );

    const drafted = await createDraftPackage(project, {
      directory: "pipelines/demo",
      draft: {
        pipeline: {
          id: "demo",
          model: "anthropic/claude-sonnet-4-5",
          stages: [{ id: "check", uses: "./check.yaml" }],
        },
        stages: [
          {
            path: "./check.yaml",
            body: stageBody("check", {
              tools: { functions: [{ id: "route_fn", grants: [fileGrant] }] },
            }),
          },
        ],
      },
    });
    expect(drafted.ok).toBe(false);
    if (drafted.ok) return;
    expect(drafted.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "function.kind_mismatch" })]),
    );
  });

  it("keeps a pinned run on its revision when permissions change", async () => {
    const { project, service } = await open();
    await service.create(project, toolDefinition("lookup"), ACTOR);
    const pinned = await service.pinRun(project, "run-1", ["lookup"]);
    expect(pinned).toEqual([
      expect.objectContaining({ functionId: "lookup", revision: 1, scope: "run", scopeId: "run-1" }),
    ]);
    const grants = [apiGrant, fileGrant];
    expect(await service.attachmentIssues(project, [{ kind: "tool", id: "lookup", grants }])).toEqual([]);

    const next = toolDefinition("lookup", {
      capabilities: [
        { ...apiCapability, origin: "https://other.example" },
        { ...fileCapability, root: "workspace", path: "other.json" },
      ],
    });
    const saved = await service.save(project, "lookup", { baseRevision: 1, definition: next }, ACTOR);
    expect(saved.revision).toBe(2);
    expect(await service.getPin(project, "run", "run-1", "lookup")).toMatchObject({ revision: 1 });
    expect((await service.getRevision(project, "lookup", 1)).definition.capabilities).toEqual([
      apiCapability,
      fileCapability,
    ]);

    const stale = await service.attachmentIssues(project, [{ kind: "tool", id: "lookup", grants }]);
    expect(stale.map((issue) => issue.code)).toEqual(["function.under_granted", "function.under_granted"]);

    for (const capabilities of [
      [{ ...apiCapability, methods: ["POST"] }, fileCapability],
      [{ ...apiCapability, path_prefix: "/v2" }, fileCapability],
      [{ ...apiCapability, credential_ref: "other" }, fileCapability],
      [apiCapability, { ...fileCapability, root: "workspace" }],
      [apiCapability, { ...fileCapability, path: "other.json" }],
      [...[apiCapability, fileCapability], { id: "extra", type: "env", alias: "EXTRA" }],
    ]) {
      await service.save(
        project,
        "lookup",
        { baseRevision: (await service.get(project, "lookup")).revision, definition: toolDefinition("lookup", { capabilities }) },
        ACTOR,
      );
      const issues = await service.attachmentIssues(project, [{ kind: "tool", id: "lookup", grants }]);
      expect(issues.some((issue) => issue.code === "function.under_granted")).toBe(true);
    }

    const updatedGrants = [
      { ...apiGrant, origin: "https://other.example" },
      { id: "report", root: "workspace", path: "other.json" },
    ];
    await service.save(
      project,
      "lookup",
      {
        baseRevision: (await service.get(project, "lookup")).revision,
        definition: toolDefinition("lookup", {
          capabilities: [
            { ...apiCapability, origin: "https://other.example" },
            { ...fileCapability, root: "workspace", path: "other.json" },
          ],
        }),
      },
      ACTOR,
    );
    expect(
      await service.attachmentIssues(project, [{ kind: "tool", id: "lookup", grants: updatedGrants }]),
    ).toEqual([]);
    expect((await service.getPin(project, "run", "run-1", "lookup"))?.revision).toBe(1);
  });

  it("blocks delete of a referenced function and refuses a new pin of a broken file", async () => {
    const { project, service, agents } = await open();
    await service.create(project, verification("score", { bindings: [], capabilities: [] }), ACTOR);
    await service.create(project, toolDefinition("other", { capabilities: [] }), ACTOR);
    const pinned = await service.pinRun(project, "run-keep", ["score"]);
    expect(pinned[0]?.revision).toBe(1);

    await writeFile(
      path.join(project, "stageflow.yaml"),
      [
        "version: 1",
        "model: anthropic/claude-sonnet-4-5",
        "catalog:",
        "  pipelines:",
        "    - .",
        "  tasks:",
        "    - .",
        "  patterns:",
        "    pipeline: '*.pipeline.yaml'",
        "    task: '*.task.yaml'",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(project, "uses-score.pipeline.yaml"),
      [
        "id: uses_score",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: check",
        "    system_prompt: Check.",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "    verify:",
        "      - id: score",
        "        type: function",
        "        function: score",
        "        grants: []",
        "",
      ].join("\n"),
    );
    await expect(service.delete(project, "score")).rejects.toMatchObject({
      code: "function.in_use",
      usages: [expect.objectContaining({ path: expect.stringContaining("uses-score.pipeline.yaml") })],
    });

    await writeFile(path.join(project, "functions", "score.function.yaml"), "id: [\n");
    await expect(service.pinRun(project, "run-new", ["score"])).rejects.toMatchObject({
      code: "function.invalid",
    });
    expect((await service.getRevision(project, "score", 1)).definition.source).toBe(SOURCE);
    expect((await service.getPin(project, "run", "run-keep", "score"))?.revision).toBe(1);

    await writeFile(
      path.join(project, "plain.pipeline.yaml"),
      [
        "id: plain",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: only",
        "    system_prompt: Go.",
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
    const plain = await loadPipelineOutcome(path.join(project, "plain.pipeline.yaml"), {
      cwd: project,
      projectRoot: project,
    });
    expect(plain.ok).toBe(true);
    const otherPin = await service.pinRun(project, "run-other", ["other"]);
    expect(otherPin[0]?.revision).toBe(1);

    const hidden = path.join(project, "hidden");
    await mkdir(hidden);
    await writeFile(
      path.join(project, "stageflow.yaml"),
      [
        "version: 1",
        "model: anthropic/claude-sonnet-4-5",
        "catalog:",
        "  pipelines:",
        "    - hidden",
        "  tasks: []",
        "  patterns:",
        "    pipeline: '*.pipeline.yaml'",
        "    task: '*.task.yaml'",
        "",
      ].join("\n"),
    );
    await chmod(hidden, 0);
    try {
      await expect(service.delete(project, "other")).rejects.toMatchObject({
        code: "function.catalog_unreadable",
      });
    } finally {
      await chmod(hidden, 0o755);
    }

    await agents.create(project, { id: "helper", name: "Helper", instructions: "Help." }, ACTOR);
    const agent = await agents.get(project, "helper");
    await expect(
      agents.save(
        project,
        "helper",
        {
          baseRevision: agent.agent.revision,
          definition: {
            ...agent.definition,
            tools: { functions: [{ id: "other", grants: [], extra: true }] },
          },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "agent.invalid" });
    await expect(
      agents.save(
        project,
        "helper",
        {
          baseRevision: agent.agent.revision,
          definition: {
            ...agent.definition,
            tools: { functions: [{ id: "other", grants: [{ id: "not_declared" }] }] },
          },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      code: "agent.invalid",
      issues: [expect.objectContaining({ code: "function.grant_not_requested" })],
    });

    const savedAgent = await agents.save(
      project,
      "helper",
      {
        baseRevision: agent.agent.revision,
        definition: {
          ...agent.definition,
          tools: { functions: [{ id: "other", grants: [] }] },
        },
      },
      ACTOR,
    );
    expect(savedAgent.definition?.tools.functions).toEqual([{ id: "other", grants: [] }]);
    await expect(service.delete(project, "other")).rejects.toMatchObject({ code: "function.in_use" });
  });

  it("conflicts on a stale base revision and skips an unchanged parse", async () => {
    const { project, service } = await open();
    await service.create(project, verification("score", { bindings: [], capabilities: [] }), ACTOR);
    const same = await service.save(
      project,
      "score",
      { baseRevision: 1, definition: verification("score", { bindings: [], capabilities: [] }) },
      ACTOR,
    );
    expect(same.revision).toBe(1);
    expect(await service.listRevisions(project, "score")).toHaveLength(1);

    const first = service.save(
      project,
      "score",
      { baseRevision: 1, definition: verification("score", { bindings: [], capabilities: [], description: "one" }) },
      ACTOR,
    );
    const second = service.save(
      project,
      "score",
      { baseRevision: 1, definition: verification("score", { bindings: [], capabilities: [], description: "two" }) },
      ACTOR,
    );
    const settled = await Promise.allSettled([first, second]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "function.conflict",
      currentRevision: 2,
    });
    expect((await service.get(project, "score")).revision).toBe(2);
  });

  it("waits for an in-flight save and refuses to pin a file with issues", async () => {
    const { project, service } = await open();
    await service.create(project, verification("score", { bindings: [], capabilities: [] }), ACTOR);
    const savePromise = service.save(
      project,
      "score",
      { baseRevision: 1, definition: verification("score", { bindings: [], capabilities: [], description: "committed" }) },
      ACTOR,
    );
    const pinPromise = service.pinRun(project, "run-wait", ["score"]);
    const saved = await savePromise;
    const pinned = await pinPromise;
    expect(pinned[0]?.revision).toBe(saved.revision);
    expect(pinned[0]?.revision).toBe(2);

    await writeFile(path.join(project, "functions", "score.function.yaml"), "kind: [\n");
    await expect(service.pinSession(project, "session-1", ["score"])).rejects.toBeInstanceOf(FunctionError);
    await expect(service.pinSession(project, "session-1", ["score"])).rejects.toMatchObject({
      code: "function.invalid",
    });
    expect((await service.getPin(project, "run", "run-wait", "score"))?.revision).toBe(2);
  });

  it("rejects catalog writes of function files", async () => {
    const { project } = await open();
    expect(catalogFileKind("functions/example.function.yaml", "id: example\n")).not.toBe("stage");
    const rejected = await writeCatalogFileForHttp({
      projectRoot: project,
      inputPath: "functions/example.function.yaml",
      content: "id: example\n",
      create: true,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("use_function_api");
  });

  it("parses the fixture function", async () => {
    const text = await readFile(path.join(process.cwd(), "tests/fixtures/functions/score.function.yaml"), "utf8");
    const parsed = parseFunctionYaml(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe("score");
    expect(parsed.value.kind).toBe("verification");
    const declared = parseFunctionYaml(
      await readFile(path.join(process.cwd(), "tests/fixtures/functions/score_access.function.yaml"), "utf8"),
    );
    expect(declared.ok).toBe(true);
    if (declared.ok) expect(declared.value.capabilities.map((capability) => capability.id)).toEqual(["artifacts", "env_min_score"]);
  });

  it("rejects a write capability on a verification", async () => {
    const { project, service } = await open();
    await expect(
      service.create(
        project,
        verification("score", {
          bindings: [],
          capabilities: [{ ...fileCapability, access: "write" }],
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "function.invalid" });
  });

  it("derives capabilities from an access declaration and keeps legacy files unchanged", async () => {
    const { project, service } = await open();
    const source = [
      "export const access = {",
      '  artifacts: "read",',
      '  env: ["MIN_SCORE", "REGION?"],',
      '  network: ["https://api.example.com"],',
      "};",
      "export default function execute(context) {",
      "  return { passed: true, region: context.env.REGION };",
      "}",
      "",
    ].join("\n");
    const created = await service.create(
      project,
      { id: "score", name: "Score", kind: "verification", source },
      ACTOR,
    );
    expect(created.definition?.capabilities).toEqual([
      { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
      { id: "env_min_score", type: "env", alias: "MIN_SCORE" },
      { id: "env_region", type: "env", alias: "REGION" },
      {
        id: "api_api_example_com",
        type: "api",
        origin: "https://api.example.com",
        methods: ["GET"],
        path_prefix: "/",
        effect: "read",
      },
    ]);
    expect(created.definition?.bindings).toEqual([
      { alias: "MIN_SCORE", required: true },
      { alias: "REGION", required: false },
    ]);
    const onDisk = await readFile(path.join(project, "functions", "score.function.js"), "utf8");
    expect(onDisk).not.toContain("capabilities:");
    expect(onDisk).not.toContain("bindings:");
    const fetched = await service.get(project, "score");
    expect(fetched.definition?.capabilities).toEqual(created.definition?.capabilities);

    const same = await service.save(project, "score", { baseRevision: 1, definition: { id: "score", name: "Score", kind: "verification", source } }, ACTOR);
    expect(same.revision).toBe(1);

    const editedSource = source.replace('artifacts: "read"', 'artifacts: "none"');
    const edited = await service.save(
      project,
      "score",
      { baseRevision: 1, definition: { id: "score", name: "Score", kind: "verification", source: editedSource } },
      ACTOR,
    );
    expect(edited.revision).toBe(2);
    expect(edited.definition?.capabilities.some((capability) => capability.id === "artifacts")).toBe(false);

    const hand = [
      "id: hand",
      "name: Hand",
      "kind: verification",
      "source: |",
      "  export const access = {",
      '    artifacts: "read",',
      "    env: [],",
      "    network: [],",
      "  };",
      "  export default function execute() {",
      "    return { passed: true };",
      "  }",
      "",
    ].join("\n");
    await writeFile(path.join(project, "functions", "hand.function.yaml"), hand);
    const synced = await service.get(project, "hand");
    expect(synced.definition?.capabilities).toEqual([
      { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
    ]);
    expect(synced.definition?.bindings).toEqual([]);

    const mismatch = service.create(
      project,
      {
        id: "wide",
        name: "Wide",
        kind: "verification",
        source,
        capabilities: [{ id: "workspace", type: "file", root: "workspace", path: "", access: "read" }],
        bindings: [],
      },
      ACTOR,
    );
    await expect(mismatch).rejects.toMatchObject({
      code: "function.invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "capabilities",
          code: "function.access_conflict",
          message: "Remove capabilities and bindings, or make them match the access declaration in the source",
        }),
      ]),
    });

    const matched = await service.create(
      project,
      {
        id: "matched",
        name: "Matched",
        kind: "verification",
        source: editedSource,
        capabilities: edited.definition?.capabilities,
        bindings: edited.definition?.bindings,
      },
      ACTOR,
    );
    expect(matched.definition?.capabilities).toEqual(edited.definition?.capabilities);

    const writeSource = source.replace('artifacts: "read"', 'artifacts: "write"');
    await expect(
      service.create(project, { id: "writer", name: "Writer", kind: "verification", source: writeSource }, ACTOR),
    ).rejects.toMatchObject({
      code: "function.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "function.write_not_allowed", path: "source" })]),
    });

    const fixture = await readFile(path.join(process.cwd(), "tests/fixtures/functions/score.function.yaml"), "utf8");
    const legacy = parseFunctionYaml(fixture);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    const serialized = serializeFunctionDefinition(legacy.value);
    expect(serialized).toContain("\ncapabilities:\n");
    expect(serialized).toContain("\nbindings:");
    const again = parseFunctionYaml(serialized);
    expect(again).toEqual(legacy);
    expect(serializeFunctionDefinition(legacy.value)).toBe(serialized);
  });

  it("defaults create to js, preserves format on save, and scans conflicts", async () => {
    const { project, service } = await open();
    const yamlCreated = await service.create(project, verification("yaml_only"), ACTOR, { format: "yaml" });
    expect(yamlCreated.path).toBe("functions/yaml_only.function.yaml");
    await service.save(
      project,
      "yaml_only",
      { baseRevision: 1, definition: verification("yaml_only", { description: "Still yaml" }) },
      ACTOR,
    );
    expect(await readFile(path.join(project, "functions", "yaml_only.function.yaml"), "utf8")).toContain("Still yaml");
    await expect(readFile(path.join(project, "functions", "yaml_only.function.js"), "utf8")).rejects.toThrow();

    const jsCreated = await service.create(project, verification("js_only"), ACTOR);
    expect(jsCreated.path).toBe("functions/js_only.function.js");
    const jsBody = await readFile(path.join(project, "functions", "js_only.function.js"), "utf8");
    expect(parseFunctionJs(jsBody).ok).toBe(true);
    await service.save(
      project,
      "js_only",
      { baseRevision: 1, definition: verification("js_only", { description: "Still js" }) },
      ACTOR,
    );
    const jsSaved = await readFile(path.join(project, "functions", "js_only.function.js"), "utf8");
    expect(jsSaved).toContain("Still js");
    expect(jsSaved.startsWith("---\n")).toBe(true);

    await writeFile(path.join(project, "functions", "helper.js"), "export default 1;\n");
    expect((await service.list(project)).map((row) => row.id).sort()).toEqual(["js_only", "yaml_only"]);

    await writeFile(
      path.join(project, "functions", "yaml_only.function.yml"),
      await readFile(path.join(project, "functions", "yaml_only.function.yaml"), "utf8"),
    );
    const conflicted = await service.get(project, "yaml_only");
    expect(conflicted.issues).toEqual([expect.objectContaining({ code: "function.id_conflict" })]);
    expect(conflicted.definition).toBeNull();

    const crossDefinition = parseFunctionDefinition(verification("cross"));
    expect(crossDefinition.ok).toBe(true);
    if (!crossDefinition.ok) return;
    await writeFile(path.join(project, "functions", "cross.function.js"), serializeFunctionJsFile(crossDefinition.value));
    await writeFile(path.join(project, "functions", "cross.function.yaml"), serializeFunctionDefinition(crossDefinition.value));
    const cross = await service.get(project, "cross");
    expect(cross.issues).toEqual([expect.objectContaining({ code: "function.format_conflict" })]);
    expect(cross.definition).toBeNull();

    await expect(service.create(project, verification("js_only"), ACTOR)).rejects.toMatchObject({ code: "function.exists" });
  });
});
