import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAgentArtifactPrompt, createAgentPublishArtifactTool } from "../src/agents/artifactTools.js";
import { agentProjectKey } from "../src/agents/store.js";
import { bindableFunctionsFromAttachments } from "../src/artifacts/bindable.js";
import { liveArtifactsPromptSection, promptTokenEstimate } from "../src/artifacts/livePrompt.js";
import {
  EXCLUDED_COMPONENT_NAMES,
  LIBRARY_NAME,
  LIBRARY_VERSION,
  VOCABULARY,
  VOCABULARY_NAMES,
  libraryJsonSchema,
  libraryVersionStatus,
  vocabularyPrompt,
} from "../src/artifacts/library/index.js";
import { applyOpenUiTelemetryEnv } from "../src/artifacts/library/telemetryEnv.js";
import { assertOpenUiTelemetryDisabled } from "../src/artifacts/library/telemetryGuard.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { reconcileProgram, validateProgram } from "../src/artifacts/program.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { createPublishArtifactTool } from "../src/tools/publishArtifact.js";
import { composeStagePiSystemPrompt } from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import http from "node:http";
import https from "node:https";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const schema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          events: { type: "number" },
        },
      },
    },
    items: {
      type: "object",
      properties: { title: { type: "string" } },
    },
  },
};

const bindings = [{ id: "rows", function: "get_usage", args: { range: "7" } }];
const schemas = new Map([["get_usage", { outputSchema: schema }]]);

function manifest(program: string, extra: Record<string, unknown> = {}) {
  return {
    format: "openui-lang",
    library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
    bindings,
    program,
    ...extra,
  };
}

async function openStore() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-prog-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-prog-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, home, project: registered };
}

describe("live program vocabulary", () => {
  it("keeps a unique restricted library under the prompt budget", () => {
    const names = VOCABULARY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...VOCABULARY_NAMES]);
    for (const excluded of EXCLUDED_COMPONENT_NAMES) expect(names).not.toContain(excluded);
    const defs = libraryJsonSchema().$defs ?? {};
    for (const entry of VOCABULARY) {
      expect(defs[entry.name]).toBeTruthy();
      const properties = (defs[entry.name] as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties)).toEqual([...entry.props]);
    }
    const prompt = vocabularyPrompt();
    expect(prompt).toContain(LIBRARY_NAME);
    expect(prompt).toContain(LIBRARY_VERSION);
    expect(prompt).not.toMatch(/Mutation|ToAssistant|OpenUrl/);
    expect(promptTokenEstimate(prompt)).toBeLessThan(3500);
    expect(vocabularyPrompt()).toBe(prompt);
    const functions = Array.from({ length: 20 }, (_, index) => ({
      id: `fn_${String(index).padStart(2, "0")}`,
      description: "Reads a report.",
      input: "{weeks: integer}",
      output: "rows[].day, rows[].events",
    }));
    const section = liveArtifactsPromptSection(functions);
    expect(promptTokenEstimate(section)).toBeLessThan(4500);
    expect(liveArtifactsPromptSection(functions)).toBe(section);
    const long = liveArtifactsPromptSection(
      functions.map((fn) => ({
        ...fn,
        description: `${"Reads the weekly usage report for this owner. ".repeat(12)}token`,
        input: `{ weeks: integer, channel: string, ${"segment: string, ".repeat(40)} }`,
        output: `rows[].day, rows[].events, ${"rows[].bucket, ".repeat(40)}`,
      })),
    );
    expect(promptTokenEstimate(long)).toBeLessThan(4500);
    expect(long).toContain("...");
    const row = long.split("\n").find((line) => line.startsWith("- fn_00:"));
    expect(row).toBeTruthy();
    const described = row!.slice("- fn_00: ".length).split(" input ")[0] ?? "";
    expect(described.length).toBeLessThanOrEqual(200);
    expect(row!.includes("segment: string, ".repeat(40))).toBe(false);
    const empty = liveArtifactsPromptSection([]);
    expect(empty).toContain("no bindable functions: write data into the program");
    expect(empty).toContain(vocabularyPrompt());
    expect(empty).not.toContain("### Bindable functions");
    expect(empty.length).toBeLessThan(section.length);
  });

  it("reports library version status", () => {
    expect(libraryVersionStatus({ library: { name: LIBRARY_NAME, version: LIBRARY_VERSION } })).toBe("current");
    expect(libraryVersionStatus({ library: { name: LIBRARY_NAME, version: "0.9.0" } })).toBe("older");
    expect(libraryVersionStatus({ library: { name: LIBRARY_NAME, version: "2.0.0" } })).toBe("newer");
    expect(libraryVersionStatus({ library: { name: "other", version: LIBRARY_VERSION } })).toBe("unknown");
  });
});

describe("live program validation", () => {
  it("maps parser errors and tolerates a no-root fallback", () => {
    const unknown = validateProgram('root = NotAThing("x")');
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.map((issue) => issue.code)).toContain("unknown-component");
    expect(validateProgram("root = TextContent(12)").errors.map((issue) => issue.code)).toContain("type-mismatch");
    const fallback = validateProgram('header = Stack([TextContent("hi")])');
    expect(fallback.ok).toBe(true);
    expect(fallback.warnings.map((issue) => issue.code)).toContain("no-root");
    expect(validateProgram("foo")).toMatchObject({ ok: false });
    expect(validateProgram('root = TextContent("card")')).toEqual(validateProgram('root = TextContent("card")'));
  });

  it("rejects hostile programs without hanging", () => {
    const repeated = "foo ".repeat(Math.ceil((512 * 1024) / 4)).slice(0, 512 * 1024);
    const started = performance.now();
    expect(validateProgram(repeated).ok).toBe(false);
    expect(validateProgram("(".repeat(80) + "x").errors[0]?.code).toBe("nesting-limit");
    expect(validateProgram(`"${"a".repeat(20_000)}`).ok).toBe(false);
    const cycle = Array.from({ length: 2000 }, (_, index) => `a${index + 1} = a${index === 1999 ? 1 : index + 2}`).join("\n");
    expect(validateProgram(cycle).errors.map((issue) => issue.code)).toContain("reference-cycle");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reconciles query tools, fields, aliases, and warnings", () => {
    const alias = reconcileProgram(
      '$range = "7"\ndata = Query("get_usage", {range: $range}, {rows: []})\nrows = data.rows\nnote = rows.day\nroot = TextContent("x")',
      bindings,
      schemas,
    );
    expect(alias.errors).toEqual([]);
    expect(reconcileProgram(
      'data = Query("get_usage", {range: "7"}, {rows: []})\nnote = data.rows.count\nroot = TextContent("x")',
      bindings,
      schemas,
    ).errors[0]).toMatchObject({ code: "unknown-field" });
    expect(reconcileProgram(
      'data = Query("get_usage", {range: "7"}, {rows: []})\nroot = TextContent("x")\nnote = data.items.title',
      bindings,
      schemas,
    ).errors).toEqual([]);
    expect(reconcileProgram(
      'data = Query("get_usage", {range: "30"}, {rows: []})\nnote = data.rows.day\nroot = TextContent("x")',
      bindings,
      schemas,
    ).warnings.map((issue) => issue.code)).toContain("binding-args");
    expect(reconcileProgram(
      'data = Query("get_usage", {range: "7"}, {rows: []})\nroot = TextContent("x")',
      bindings,
      new Map(),
    ).warnings.map((issue) => issue.code)).toContain("output-schema-missing");
    const conditional = reconcileProgram(
      'usage = $on ? Query("get_usage", {range: "7"}, {rows: []}) : Query("other", {}, {})\nroot = TextContent("x")',
      bindings,
      schemas,
    );
    expect(conditional.errors.map((issue) => issue.code)).toContain("inline-reserved");
    expect(conditional.errors.map((issue) => issue.code)).not.toContain("unknown-field");
    expect(reconcileProgram('root = TextContent("x")', bindings, schemas).warnings.map((issue) => issue.code)).toContain(
      "binding-unused",
    );
    expect(reconcileProgram('root = TextContent("x")', [], schemas).errors).toEqual([]);
    const shape = "the tool name must be a single string literal that matches a bound function";
    const smuggled = [
      ['d = Query("get_usage" + "_evil", {})\nroot = TextContent("x")', "shape"],
      ['d = Query("get_usage" || "evil", {})\nroot = TextContent("x")', "shape"],
      ['d = Query("get_usage" ?? "evil", {})\nroot = TextContent("x")', "shape"],
      ['d = Query("get_usage" == "x" ? "evil" : "get_usage", {})\nroot = TextContent("x")', "shape"],
      ['d = Query("get_usag\\e", {})\nroot = TextContent("x")', "shape"],
      ['d = @Query("evil", {})\nroot = TextContent("x")', "unbound"],
    ] as const;
    for (const [program, kind] of smuggled) {
      const validated = validateProgram(program);
      const reconciled = reconcileProgram(program, bindings, schemas);
      expect(validated.ok && reconciled.errors.length === 0, program).toBe(false);
      const messages = [...validated.errors, ...reconciled.errors].map((issue) => issue.message).join("\n");
      if (kind === "shape") expect(messages).toContain(shape);
      else expect(reconciled.errors.map((issue) => issue.code)).toContain("unknown-tool");
    }
    expect(
      reconcileProgram('d = @Query("get_usage", {range: "7"})\nroot = TextContent("x")', bindings, schemas).errors,
    ).toEqual([]);
    const inline = reconcileProgram('root = TextContent(Query("get_usage", {range: "7"}).nope)', bindings, schemas);
    expect(inline.errors.map((issue) => issue.code)).toContain("inline-reserved");
    expect(inline.errors.map((issue) => issue.code)).not.toContain("unknown-field");
    expect(validateProgram('root = TextContent("aaa').errors.map((issue) => issue.code)).toContain("unterminated-string");
    const warned = validateProgram('root = TextContent("See https://example.com")');
    expect(warned.ok).toBe(true);
    expect(warned.warnings.map((issue) => issue.message)).toContain("URL-like text: rendered as plain text");
    expect(validateProgram('root = Tag("javascript:alert(1)")').warnings.map((issue) => issue.code)).toContain("url-like-text");
    expect(validateProgram('root = TextContent("data:text/plain,hi")').warnings.map((issue) => issue.code)).toContain("url-like-text");
    expect(validateProgram(`d = Query('get_usage', {})\nroot = TextContent("x")`).ok).toBe(false);
    expect(
      reconcileProgram(`d = Query('get_usage', {})\nroot = TextContent("x")`, bindings, schemas).errors.map((issue) => issue.message).join("\n"),
    ).toContain(shape);
    const quoted = reconcileProgram('d = Query("get_usage", {range: "7"})\nroot = TextContent("x")', bindings, schemas);
    expect(quoted.errors).toEqual([]);
    const breaks = [
      "\u200B",
      "\u200C",
      "\u200D",
      "\u200E",
      "\u200F",
      "\u2060",
      "\u2061",
      "\u2062",
      "\u2063",
      "\u2064",
      "\uFEFF",
      "\u00A0",
      "\u000B",
      "\u000C",
      "\u0085",
      "\u2028",
      "\u2029",
      "\u1680",
      "\u2000",
      "\u202F",
      "\u205F",
      "\u3000",
    ];
    for (const char of breaks) {
      const program = `d = TextContent(Query${char}\n("evil", {}).rows)\nroot = TextContent("x")`;
      const validated = validateProgram(program);
      expect(validated.ok, `U+${char.codePointAt(0)!.toString(16)}`).toBe(false);
      expect(validated.errors.map((issue) => issue.code)).toContain("invalid-character");
    }
    const continued = 'd = TextContent(Query\\\n("evil", {}).rows)\nroot = TextContent("x")';
    expect(validateProgram(continued).errors.map((issue) => issue.code)).toContain("inline-reserved");
    expect(validateProgram('root = TextContent("a\u200Bb")').ok).toBe(true);
    expect(validateProgram('root = TextContent("x") // \u200B\n').ok).toBe(true);
  });

  it("rejects hostile programs in linear time", () => {
    const measure = (source: string) => {
      const before = process.memoryUsage().heapUsed;
      const started = performance.now();
      const result = validateProgram(source);
      return { result, ms: performance.now() - started, heap: process.memoryUsage().heapUsed - before };
    };
    const cases = [
      `root = ${"a.".repeat(32_000)}b`,
      "a.".repeat(256 * 1024) + "b",
      Array.from({ length: 100_000 }, () => "a.b").join("\n"),
      `{${"k:1,".repeat(20_000)}}`,
      Array.from({ length: 8_000 }, (_, index) => `a${index}=1`).join("\n"),
      `${"a[0].b[1].".repeat(8_000)}c`,
    ];
    for (const source of cases) {
      const measured = measure(source);
      expect(measured.ms).toBeLessThan(500);
      expect(measured.heap).toBeLessThan(100 * 1024 * 1024);
      expect(measured.result.ok).toBe(false);
      expect(measured.result.errors[0]?.code).toBeTruthy();
    }
  });

  it("aborts when the parse budget is exceeded", () => {
    let ticks = 0;
    const result = validateProgram(`root = TextContent("${"a".repeat(8_000)}")`, {
      now: () => {
        ticks += 1;
        return ticks < 40 ? 0 : 5_000;
      },
      budgetMs: 250,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain("program-too-complex");
    expect(result.errors[0]?.message).toBe("program too complex");
  });

  it("does not block the event loop on a 100KB hostile program", async () => {
    const hostile = `root = ${"a.".repeat(50_000)}b`;
    let blocked = 0;
    const interval = 20;
    await new Promise<void>((resolve) => {
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        blocked = Math.max(blocked, now - last - interval);
        last = now;
      }, interval);
      setTimeout(() => {
        validateProgram(hostile);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 60);
      }, 40);
    });
    expect(blocked).toBeLessThan(150);
  });

  it("does not call the network while validating or building the prompt", () => {
    const hits: string[] = [];
    const fetchImpl = globalThis.fetch;
    globalThis.fetch = (() => {
      hits.push("fetch");
      throw new Error("network");
    }) as typeof fetch;
    const request = http.request;
    const secure = https.request;
    http.request = (() => {
      hits.push("http");
      throw new Error("network");
    }) as typeof http.request;
    https.request = (() => {
      hits.push("https");
      throw new Error("network");
    }) as typeof https.request;
    try {
      validateProgram('root = TextContent("card")');
      vocabularyPrompt();
      liveArtifactsPromptSection([]);
    } finally {
      globalThis.fetch = fetchImpl;
      http.request = request;
      https.request = secure;
    }
    expect(hits).toEqual([]);
  });
});

describe("live program publish", () => {
  it("rejects an invalid program with no stored row and accepts a corrected publish", async () => {
    const { store, home, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const bad = 'root = NotAThing("x")';
    await expect(
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "weekly",
        kind: "live.declarative",
        title: "Weekly",
        bytes: Buffer.from(bad),
        manifest: manifest(bad, { bindings: [] }),
        publishSource: "api",
        roots,
      }),
    ).rejects.toMatchObject({ code: "artifact.program_invalid" });
    const count = db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number };
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM artifact_versions`).get() as { n: number };
    expect(count.n).toBe(0);
    expect(versions.n).toBe(0);
    const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_fts'`).get();
    if (fts) {
      const indexed = db.prepare(`SELECT COUNT(*) AS n FROM artifact_fts`).get() as { n: number };
      expect(indexed.n).toBe(0);
    }
    const stored = path.join(home, "artifacts");
    const entries = await readdir(stored).catch(() => []);
    expect(entries).toEqual([]);
    const good = 'root = TextContent("card")';
    const published = await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: project,
      id: "weekly",
      kind: "live.declarative",
      title: "Weekly",
      bytes: Buffer.from(good),
      manifest: manifest(good, { bindings: [] }),
      publishSource: "api",
      roots,
      hidden: true,
      ownerNamespace: "eval",
    });
    expect(published.version).toBe(1);
    await expect(
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "other",
        kind: "live.declarative",
        title: "Other",
        bytes: Buffer.from(good),
        manifest: { ...manifest(good, { bindings: [] }), format: "stageflow-json" },
        publishSource: "api",
        roots,
      }),
    ).rejects.toMatchObject({ code: "artifact.invalid_shape" });
  });

  it("returns program issues from the stage and agent tools, then accepts the fix", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    const stageTool = createPublishArtifactTool({
      runWorkspaceDir: project,
      stageId: "summarize",
      attempt: 1,
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          {
            owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
            projectRoot: project,
            source: { runId: "run-1", stageId: "summarize", attempt: 1 },
          },
          body,
        ),
    });
    const bad = await stageTool.execute("call-1", {
      id: "weekly",
      kind: "live.declarative",
      title: "Weekly",
      content: 'root = NotAThing("x")',
      format: "openui-lang",
      library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      bindings: [],
    });
    expect(bad.isError).toBe(true);
    const badPayload = JSON.parse(bad.content[0]!.text) as { code: string; issues: Array<{ code: string }> };
    expect(badPayload.code).toBe("artifact.program_invalid");
    expect(badPayload.issues.map((issue) => issue.code)).toContain("unknown-component");
    const fixed = await stageTool.execute("call-2", {
      id: "weekly",
      kind: "live.declarative",
      title: "Weekly",
      content: 'root = TextContent("card")',
      format: "openui-lang",
      library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      bindings: [],
    });
    expect(fixed.isError).toBeUndefined();
    const agentTool = createAgentPublishArtifactTool({
      agentId: "helper",
      projectRoot: project,
      stageflowHome: process.env.STAGEFLOW_HOME ?? "",
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: { kind: "agent", agent: "helper" }, projectRoot: project, source: { sessionId: "sess-1" } },
          body,
        ),
    });
    const agentBad = await agentTool.execute("call-3", {
      id: "board",
      kind: "live.declarative",
      title: "Board",
      content: "root = TextContent(12)",
      format: "openui-lang",
      library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      bindings: [],
    });
    expect(JSON.parse(agentBad.content[0]!.text).code).toBe("artifact.program_invalid");
    const agentFixed = await agentTool.execute("call-4", {
      id: "board",
      kind: "live.declarative",
      title: "Board",
      content: 'root = TextContent("board")',
      format: "openui-lang",
      library: { name: LIBRARY_NAME, version: LIBRARY_VERSION },
      bindings: [],
    });
    expect(agentFixed.isError).toBeUndefined();
  });
});

describe("live program prompt", () => {
  it("lists only the owner's bindable functions and stays absent without the opt-in", async () => {
    const { project } = await openStore();
    await writeFile(path.join(project, "stageflow.yaml"), "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n");
    const source = "export const access = { network: [] };\nexport default async function execute() { return { rows: [] }; }\n";
    for (const id of ["get_usage", "other_tool"]) {
      const file = functionFilePath(project, id);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `id: ${id}\nname: ${id}\nkind: tool\ntool_name: ${id}\ntool_description: Read ${id}\ninput_schema:\n  type: object\n  properties:\n    range:\n      type: string\noutput_schema:\n  type: object\n  properties:\n    rows:\n      type: array\n      items:\n        type: object\n        properties:\n          day:\n            type: string\nsource: |\n${source
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n`,
      );
    }
    const secretFile = functionFilePath(project, "secret_tool");
    await writeFile(
      secretFile,
      `id: secret_tool\nname: secret_tool\nkind: tool\ntool_name: secret_tool\ntool_description: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\ninput_schema:\n  type: object\n  properties: {}\nsource: |\n  export default async function execute() { return {}; }\n`,
    );
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales\nstages:\n  - id: summarize\n    artifacts:\n      publish: true\n    tools:\n      functions:\n        - id: get_usage\n        - id: secret_tool\n`,
    );
    const listed = bindableFunctionsFromAttachments(project, [{ id: "get_usage" }, { id: "secret_tool" }]);
    expect(listed.map((item) => item.id)).toEqual(["get_usage", "secret_tool"]);
    expect(listed.map((item) => item.id)).not.toContain("other_tool");
    expect(JSON.stringify(listed)).not.toContain("sk-ant-api03");
    const input = {
      roots: { cwd: project },
      projectRoot: project,
      stage: {
        id: "summarize",
        system_prompt: "Publish.",
        model: "anthropic/claude-sonnet-4-5",
        artifacts: { publish: true as const },
        tools: { functions: [{ id: "get_usage", grants: [] }, { id: "secret_tool", grants: [] }] },
      },
      task: { id: "task", goal: "Write." },
      priorEnvelope: null,
    } as StageRunInput;
    const system = composeStagePiSystemPrompt(input, "emit_stage_envelope", undefined, "write_stage_artifact");
    expect(system).toContain("## Live artifacts");
    expect(system).toContain("get_usage");
    expect(system).not.toContain("other_tool");
    expect(system).not.toContain("sk-ant-api03");
    const plain = composeStagePiSystemPrompt(
      { ...input, stage: { ...input.stage, artifacts: undefined, tools: undefined } },
      "emit_stage_envelope",
      undefined,
      "write_stage_artifact",
    );
    expect(plain).not.toContain("## Live artifacts");
    expect(plain).not.toContain("# Published artifacts");
    const parsed = parseAgentDefinition({
      id: "helper",
      name: "Helper",
      instructions: "Help.",
      tools: { functions: [{ id: "get_usage" }], stageflow: { groups: ["artifacts.write"] } },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const agentPrompt = appendAgentArtifactPrompt("Help.", parsed.value, project);
    expect(agentPrompt).toContain("## Live artifacts");
    expect(agentPrompt).toContain("get_usage");
    expect(agentPrompt).not.toContain("other_tool");
    const without = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help.", tools: { stageflow: { groups: ["runs.read"] } } });
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(appendAgentArtifactPrompt("Help.", without.value, project)).toBe("Help.");
  });
});

describe("live program regression harness", () => {
  it("dry-runs the five tasks without a key or a model", () => {
    const full = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/artifacts/live-program-regression.ts", "--dry-run", "--max-usd", "1.5"],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout).toContain('"task": "bar"');
    const stopped = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/artifacts/live-program-regression.ts", "--dry-run", "--max-usd", "0.02"],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain('"tasks": []');
    const summary = JSON.parse(full.stdout) as { outPath: string };
    expect(summary.outPath).toContain("stageflow-live-regression");
    expect(summary.outPath).not.toContain(`${path.sep}.scratch${path.sep}`);
    expect(readFileSync(summary.outPath, "utf8")).toContain('"task": "kpi"');
  });
});

describe("openui telemetry guard", () => {
  it("forces the opt-out and refuses to load lang-core without it", () => {
    process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED = "1";
    applyOpenUiTelemetryEnv();
    expect(process.env.OPENUI_TELEMETRY_DISABLED).toBe("1");
    expect(process.env.DO_NOT_TRACK).toBe("1");
    expect(process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED).toBeUndefined();
    expect(() => assertOpenUiTelemetryDisabled({ OPENUI_TELEMETRY_DISABLED: "" })).toThrow(/OPENUI_TELEMETRY_DISABLED/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { allowScripts?: Record<string, boolean> };
    expect(Object.keys(pkg.allowScripts ?? {}).some((name) => name.startsWith("@openuidev/"))).toBe(false);
    const installed = JSON.parse(readFileSync("node_modules/@openuidev/lang-core/package.json", "utf8")) as {
      scripts?: { postinstall?: string };
    };
    expect(installed.scripts?.postinstall).toContain("postinstall.cjs");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "delete process.env.OPENUI_TELEMETRY_DISABLED; delete process.env.DO_NOT_TRACK; await import('./src/artifacts/library/langCore.ts');",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OPENUI_TELEMETRY_DISABLED: "", DO_NOT_TRACK: "" },
      },
    );
    expect(child.status).not.toBe(0);
    expect(`${child.stderr}\n${child.stdout}`).toContain("OPENUI_TELEMETRY_DISABLED");
  });
});
