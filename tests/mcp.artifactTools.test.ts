import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import { MCP_IMAGE_CONTENT_MAX_BYTES, MCP_TEXT_CONTENT_MAX_BYTES, capArtifactSnapshotsForMcp, registerArtifactTools } from "../src/mcp/artifactTools.js";
import { toolAnnotations } from "../src/mcp/defineTool.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { createMcpHttpHandler } from "../src/mcp/server.js";
import { resolveToolsets } from "../src/mcp/toolsets.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";
import { grantedStageflowTools, TOOL_META, toolsInGroup } from "../src/toolkit/meta.js";
import { mcpUrl } from "./helpers/mcpCall.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const OWNER = { kind: "stage" as const, pipeline: "sales", stage: "summarize" };
const OWNER_KEY = "stage:sales:summarize";

type RecordedTool = {
  name: string;
  description: string;
  inputSchema: ZodType | undefined;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;
const previousCredential = process.env.STAGEFLOW_CREDENTIAL_HOME;

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  if (previousCredential === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
  else process.env.STAGEFLOW_CREDENTIAL_HOME = previousCredential;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function open() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-art-mcp-home-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "sf-art-mcp-proj-"));
  dirs.push(home, projectDir);
  process.env.STAGEFLOW_HOME = home;
  process.env.STAGEFLOW_CREDENTIAL_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const project = await store.ensureProject(projectDir);
  closers.push(async () => {
    await store.close().catch(() => undefined);
  });
  const tools = record({ cwd: projectDir, store, manager: {} as never });
  return { home, project, projectDir, store, tools };
}

function record(deps: McpToolDeps): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodType },
      handler: RecordedTool["handler"],
    ) {
      tools.push({ name, description: config.description ?? "", inputSchema: config.inputSchema, handler });
    },
  };
  registerArtifactTools(server as unknown as McpServer, deps);
  return tools;
}

async function call(tools: RecordedTool[], name: string, args: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, name).toBeDefined();
  const result = await tool!.handler(args);
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
  };
}

function stage(project: string, patch: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    owner: OWNER,
    project_root: project,
    id: "weekly",
    kind: "static.markdown",
    title: "Weekly",
    content: "# weekly\n",
    ...patch,
  };
  if (body.content_base64 !== undefined && !Object.prototype.hasOwnProperty.call(patch, "content")) {
    delete body.content;
  }
  return body;
}

describe("artifact MCP tools", () => {
  it("registers the artifact tools without route paths in the descriptions", async () => {
    const { tools } = await open();
    expect(tools.map((tool) => tool.name)).toEqual(["get_artifact", "save_artifact", "refresh_artifact", "delete_artifact"]);
    for (const tool of tools) {
      expect(tool.description.includes("/api/")).toBe(false);
      expect(TOOL_META[tool.name]).toBeDefined();
    }
    expect(TOOL_META.get_artifact).toMatchObject({ groups: ["artifacts.read"], risk: "read", toolset: "artifacts" });
    expect(TOOL_META.save_artifact).toMatchObject({ groups: ["artifacts.write"], risk: "write", toolset: "artifacts" });
    expect(TOOL_META.delete_artifact).toMatchObject({
      groups: ["artifacts.cleanup"],
      risk: "destructive",
      toolset: "artifacts",
    });
    expect(toolAnnotations("get_artifact")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(toolAnnotations("save_artifact")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(toolAnnotations("delete_artifact")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(TOOL_META.refresh_artifact).toMatchObject({
      groups: ["artifacts.refresh"],
      risk: "external",
      toolset: "artifacts",
    });
    expect(toolAnnotations("refresh_artifact")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(toolsInGroup("artifacts.refresh")).toEqual(["refresh_artifact"]);
    expect(resolveToolsets(undefined).tools).not.toContain("get_artifact");
    expect(resolveToolsets("artifacts").tools).toEqual(
      [...new Set([...resolveToolsets(undefined).tools, "get_artifact", "save_artifact", "refresh_artifact", "delete_artifact"])].sort(),
    );
  });

  it("lists with filters and paging, ignores q, and hides eval artifacts", async () => {
    const { project, store, tools } = await open();
    const first = await call(tools, "save_artifact", stage(project, { id: "alpha", title: "Alpha", tags: ["weekly"], content: "alpha" }));
    const second = await call(tools, "save_artifact", stage(project, { id: "bravo", title: "Bravo", kind: "static.text", content: "bravo" }));
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);

    const db = sqliteConnectionFromStore(store);
    db!.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at
       ) VALUES (
         'hidden-row', 'stage', 'sales', 'summarize', ?, 'hiddenone', 'Hidden secret', '[]',
         'static.text', 'published', 1, 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
       )`,
    ).run(first.payload.project_root);

    const page = await call(tools, "get_artifact", { list: true, project_root: project, sort: "title", order: "asc", limit: 1 });
    expect(page.isError).toBe(false);
    const artifacts = page.payload.artifacts as Array<{ id: string; title: string }>;
    expect(artifacts.map((row) => row.id)).toEqual(["alpha"]);
    expect(page.payload.next_cursor).toEqual(expect.any(String));
    const next = await call(tools, "get_artifact", {
      list: true,
      project_root: project,
      sort: "title",
      order: "asc",
      limit: 1,
      cursor: page.payload.next_cursor,
    });
    expect((next.payload.artifacts as Array<{ id: string }>).map((row) => row.id)).toEqual(["bravo"]);

    const tagged = await call(tools, "get_artifact", { list: true, project_root: project, tag: "weekly" });
    expect((tagged.payload.artifacts as Array<{ id: string }>).map((row) => row.id)).toEqual(["alpha"]);
    const owned = await call(tools, "get_artifact", { list: true, project_root: project, owner: OWNER_KEY });
    expect(owned.payload.artifacts).toHaveLength(2);
    const kind = await call(tools, "get_artifact", { list: true, project_root: project, kind: "static.text" });
    expect((kind.payload.artifacts as Array<{ id: string }>).map((row) => row.id)).toEqual(["bravo"]);
    const live = await call(tools, "get_artifact", { list: true, project_root: project, live: true });
    expect(live.payload.artifacts).toEqual([]);
    const searched = await call(tools, "get_artifact", { list: true, project_root: project, q: "alpha" });
    expect((searched.payload.artifacts as Array<{ id: string }>).map((row) => row.id)).toEqual(["alpha"]);
    const missed = await call(tools, "get_artifact", { list: true, project_root: project, q: "no-such-needle" });
    expect(missed.payload.artifacts).toEqual([]);
    const hidden = await call(tools, "get_artifact", { key: `${OWNER_KEY}/hiddenone`, project_root: project });
    expect(hidden.isError).toBe(true);
    expect(hidden.payload.code).toBe("artifact.not_found");

    db!.prepare(`UPDATE artifacts SET status = 'expired' WHERE id = 'bravo'`).run();
    const expired = await call(tools, "get_artifact", { list: true, project_root: project, status: "expired" });
    expect((expired.payload.artifacts as Array<{ id: string }>).map((row) => row.id)).toEqual(["bravo"]);
    const bad = await call(tools, "get_artifact", { list: true, sort: "nope" });
    expect(bad.payload.code).toBe("artifact.invalid_filter");
  });

  it("ignores hidden on save_artifact and does not return an eval publish from get_artifact", async () => {
    const { project, store, tools } = await open();
    const saved = await call(tools, "save_artifact", stage(project, { hidden: true, content: "shown" }));
    expect(saved.isError).toBe(false);
    const db = sqliteConnectionFromStore(store)!;
    expect(db.prepare(`SELECT hidden, source FROM artifacts WHERE id = 'weekly'`).get()).toEqual({ hidden: 0, source: "mcp" });
    const evalRun = await store.createRun({
      pipelineId: "sales",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
      origin: "eval",
    });
    await publishSessionArtifact(
      { db, roots: await catalogRootsForArtifacts(store) },
      {
        owner: OWNER,
        projectRoot: project,
        source: { runId: evalRun.runId, stageId: "summarize", attempt: 1 },
      },
      { id: "eval-note", kind: "static.markdown", title: "Eval note", bytes: Buffer.from("# eval note\n") },
    );
    const hidden = await call(tools, "get_artifact", { key: `${OWNER_KEY}/eval-note`, project_root: project });
    expect(hidden.isError).toBe(true);
    expect(hidden.payload.code).toBe("artifact.not_found");
    const listed = await call(tools, "get_artifact", { list: true, project_root: project, q: "eval" });
    expect(listed.payload.artifacts).toEqual([]);
    const rejected = await call(tools, "save_artifact", {
      ...stage(project),
      owner: { kind: "stage", pipeline: "eval:sales", stage: "summarize" },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.payload.code).toBe("artifact.invalid_shape");
  });

  it("reads record, versions and content, and reports ambiguity, not_found and not_live", async () => {
    const { project, projectDir, store, tools } = await open();
    const otherDir = await mkdtemp(path.join(tmpdir(), "sf-art-mcp-other-"));
    dirs.push(otherDir);
    const other = await store.ensureProject(otherDir);
    const saved = await call(tools, "save_artifact", stage(project, { content: "one" }));
    expect(saved.payload).toMatchObject({ key: `${OWNER_KEY}/weekly`, version: 1, unchanged: false, project_root: project });
    expect(sqliteConnectionFromStore(store)!.prepare(`SELECT source, hidden FROM artifacts WHERE id = 'weekly'`).get()).toEqual({
      source: "mcp",
      hidden: 0,
    });
    const again = await call(tools, "save_artifact", stage(project, { content: "two", title: "Weekly two" }));
    expect(again.payload).toMatchObject({ version: 2, unchanged: false });
    const same = await call(tools, "save_artifact", stage(project, { content: "two", title: "Weekly two" }));
    expect(same.payload).toMatchObject({ version: 2, unchanged: true });

    const before = sqliteConnectionFromStore(store)!
      .prepare(`SELECT updated_at FROM artifacts WHERE id = 'weekly' AND project_root_id = ?`)
      .get(project) as { updated_at: string };
    const record = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project });
    expect(record.isError).toBe(false);
    expect(record.payload).toMatchObject({ id: "weekly", version: 2, title: "Weekly two" });
    const after = sqliteConnectionFromStore(store)!
      .prepare(`SELECT updated_at FROM artifacts WHERE id = 'weekly' AND project_root_id = ?`)
      .get(project) as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);

    const older = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project, version: 1 });
    expect(older.payload).toMatchObject({ version: 1 });
    const versions = await call(tools, "get_artifact", {
      key: `${OWNER_KEY}/weekly`,
      project_root: project,
      view: "versions",
    });
    expect(versions.payload.versions).toHaveLength(2);
    const text = await call(tools, "get_artifact", {
      key: `${OWNER_KEY}/weekly`,
      project_root: project,
      view: "content",
      version: 1,
    });
    expect(text.payload).toMatchObject({ text: "one", truncated: false, size_bytes: 3 });

    const big = "a".repeat(MCP_TEXT_CONTENT_MAX_BYTES + 10);
    const truncated = await call(tools, "save_artifact", stage(project, { id: "longnote", kind: "static.text", title: "Long", content: big }));
    expect(truncated.isError).toBe(false);
    const longRead = await call(tools, "get_artifact", { key: `${OWNER_KEY}/longnote`, project_root: project, view: "content" });
    expect(longRead.payload.truncated).toBe(true);
    expect(longRead.payload.size_bytes).toBe(big.length);
    expect((longRead.payload.text as string).length).toBe(MCP_TEXT_CONTENT_MAX_BYTES);

    const boundary = `${"a".repeat(MCP_TEXT_CONTENT_MAX_BYTES - 1)}日tail`;
    const boundarySaved = await call(tools, "save_artifact", stage(project, { id: "boundary", kind: "static.text", title: "Boundary", content: boundary }));
    expect(boundarySaved.isError).toBe(false);
    const boundaryRead = await call(tools, "get_artifact", { key: `${OWNER_KEY}/boundary`, project_root: project, view: "content" });
    expect(boundaryRead.payload.truncated).toBe(true);
    expect(boundaryRead.payload.size_bytes).toBe(Buffer.byteLength(boundary));
    expect(boundaryRead.payload.text).toBe("a".repeat(MCP_TEXT_CONTENT_MAX_BYTES - 1));
    expect(String(boundaryRead.payload.text)).not.toContain("\uFFFD");
    expect(Buffer.byteLength(String(boundaryRead.payload.text))).toBeLessThanOrEqual(MCP_TEXT_CONTENT_MAX_BYTES);

    const image = await call(tools, "save_artifact", stage(project, { id: "shot", kind: "static.image", title: "Shot", content_base64: PNG.toString("base64") }));
    expect(image.isError).toBe(false);
    const imageRead = await call(tools, "get_artifact", { key: `${OWNER_KEY}/shot`, project_root: project, view: "content" });
    expect(imageRead.isError).toBe(false);
    expect(imageRead.payload.base64).toBe(PNG.toString("base64"));
    expect(imageRead.payload).not.toHaveProperty("text");

    const fat = Buffer.alloc(MCP_IMAGE_CONTENT_MAX_BYTES + 1);
    PNG.copy(fat);
    const fatSaved = await call(tools, "save_artifact", stage(project, { id: "poster", kind: "static.image", title: "Poster", content_base64: fat.toString("base64") }));
    expect(fatSaved.isError).toBe(false);
    const fatRead = await call(tools, "get_artifact", { key: `${OWNER_KEY}/poster`, project_root: project, view: "content" });
    expect(fatRead.isError).toBe(true);
    expect(fatRead.payload.code).toBe("artifact.content_too_large_for_mcp");
    expect(String(fatRead.payload.error)).not.toContain("/api/");

    const data = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project, view: "data" });
    expect(data.payload).toMatchObject({ code: "artifact.not_live", status: 404 });
    const missing = await call(tools, "get_artifact", { key: `${OWNER_KEY}/missing`, project_root: project });
    expect(missing.payload.code).toBe("artifact.not_found");

    const copy = await call(tools, "save_artifact", stage(other, { content: "other project" }));
    expect(copy.isError).toBe(false);
    const ambiguous = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly` });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.payload.code).toBe("artifact.ambiguous");
    expect(ambiguous.payload.project_roots).toEqual(expect.arrayContaining([project, other]));
    expect(projectDir).not.toBe(otherDir);
  });

  it("refreshes a live artifact and returns snapshots from view data", async () => {
    const { project, projectDir, store, tools } = await open();
    const source = "export const access = { network: [] };\nexport default async function execute(context) {\n  return { weeks: context.input && context.input.weeks };\n}\n";
    const file = functionFilePath(projectDir, "revenue_by_week");
    await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await writeFile(
      file,
      `id: revenue_by_week
name: revenue_by_week
kind: tool
tool_name: revenue_by_week
tool_description: Read revenue
input_schema:
  type: object
  properties:
    weeks:
      type: integer
  required: [weeks]
  additionalProperties: false
source: |
${source
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`,
    );
    await writeFile(
      `${projectDir}/stageflow.yaml`,
      "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n",
    );
    await writeFile(
      `${projectDir}/sales.pipeline.yaml`,
      `id: sales
stages:
  - id: summarize
    tools:
      functions:
        - id: revenue_by_week
`,
    );
    const saved = await call(
      tools,
      "save_artifact",
      stage(project, {
        kind: "live.declarative",
        content: "card\n",
        manifest: {
          format: "openui-lang",
          library: { name: "stageflow", version: "1.0.0" },
          bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
        },
      }),
    );
    expect(saved.isError).toBe(false);
    const refreshed = await call(tools, "refresh_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project });
    expect(refreshed.isError).toBe(false);
    expect(refreshed.payload).toMatchObject({
      status: "fresh",
      truncated: false,
      errors: [],
      snapshots: [expect.objectContaining({ binding_id: "rows", status: "ok", value: { weeks: 12 } })],
    });
    const live = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project, view: "data" });
    expect(live.isError).toBe(false);
    expect(live.payload).toMatchObject({
      status: "fresh",
      truncated: false,
      snapshots: [expect.objectContaining({ binding_id: "rows", value: { weeks: 12 } })],
    });
    const missing = await call(tools, "refresh_artifact", { key: `${OWNER_KEY}/missing`, project_root: project });
    expect(missing.payload).toMatchObject({ code: "artifact.not_found" });
    const capped = capArtifactSnapshotsForMcp([
      {
        binding_id: "rows",
        args_hash: "h",
        value: "x".repeat(MCP_TEXT_CONTENT_MAX_BYTES + 10),
        fetched_at: "t",
        duration_ms: 1,
        status: "ok",
        error_code: null,
      },
    ]);
    expect(capped.truncated).toBe(true);
    expect(capped.snapshots[0]?.value).toBeNull();
    expect(capped.snapshots[0]?.truncated).toBe(true);
    expect(capped.snapshots[0]?.size_bytes).toBeGreaterThan(MCP_TEXT_CONTENT_MAX_BYTES);
    expect(tools.find((tool) => tool.name === "get_artifact")?.description).toContain("list true");
    expect(tools.find((tool) => tool.name === "save_artifact")?.description).toContain("Same bytes keep the version.");
    expect(tools.find((tool) => tool.name === "delete_artifact")?.description).toContain("Indexed artifacts are refused.");
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'file_missing' WHERE id = 'weekly'`).run();
    const expired = await call(tools, "refresh_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project });
    expect(expired.payload.code).toBe("artifact.content_unavailable");
    const expiredData = await call(tools, "get_artifact", {
      key: `${OWNER_KEY}/weekly`,
      project_root: project,
      view: "data",
    });
    expect(expiredData.payload.code).toBe("artifact.content_unavailable");
    const emptyDir = await mkdtemp(path.join(tmpdir(), "sf-art-mcp-empty-"));
    dirs.push(emptyDir);
    const empty = await store.ensureProject(emptyDir);
    const foreign = await call(tools, "refresh_artifact", { key: `${OWNER_KEY}/weekly`, project_root: empty });
    expect(foreign.payload.code).toBe("artifact.not_found");
    db.prepare(`UPDATE artifacts SET status = 'available', expired_reason = NULL WHERE id = 'weekly'`).run();
    const otherDir = await mkdtemp(path.join(tmpdir(), "sf-art-mcp-other-"));
    dirs.push(otherDir);
    const other = await store.ensureProject(otherDir);
    const copy = await call(tools, "save_artifact", stage(other, { content: "other" }));
    expect(copy.isError).toBe(false);
    const ambiguous = await call(tools, "refresh_artifact", { key: `${OWNER_KEY}/weekly` });
    expect(ambiguous.payload.code).toBe("artifact.ambiguous");
  });

  it("publishes each static kind and returns validation codes", async () => {
    const { project, store, tools } = await open();
    const cases = [
      { id: "weekly", kind: "static.markdown", content: "# weekly\n" },
      { id: "note", kind: "static.text", content: "hello" },
      { id: "page", kind: "static.html", content: "<p>hi</p>" },
      { id: "sheet", kind: "static.table", content: "a,b\n1,2\n" },
      { id: "shot", kind: "static.image", content_base64: PNG.toString("base64") },
    ];
    for (const item of cases) {
      const saved = await call(tools, "save_artifact", stage(project, item));
      expect(saved.isError, item.id).toBe(false);
      expect(saved.payload).toMatchObject({ key: `${OWNER_KEY}/${item.id}`, version: 1, unchanged: false });
    }
    const source = sqliteConnectionFromStore(store)!
      .prepare(`SELECT source FROM artifacts WHERE id = 'weekly'`)
      .get() as { source: string };
    expect(source.source).toBe("mcp");

    const badId = await call(tools, "save_artifact", stage(project, { id: "Bad", content: "x" }));
    expect(badId.payload.code).toBe("artifact.invalid_id");
    const badKind = await call(tools, "save_artifact", stage(project, { id: "liveone", kind: "live.html", content: "x" }));
    expect(badKind.payload.code).toBe("artifact.invalid_kind");
    const both = await call(tools, "save_artifact", stage(project, { id: "both", content: "x", content_base64: PNG.toString("base64") }));
    expect(both.payload.code).toBe("artifact.invalid_shape");
    const neither = await call(tools, "save_artifact", { owner: OWNER, project_root: project, id: "empty", kind: "static.text", title: "Empty" });
    expect(neither.payload.code).toBe("artifact.invalid_shape");
  });

  it("deletes a published artifact and refuses an indexed one", async () => {
    const { project, store, tools } = await open();
    const saved = await call(tools, "save_artifact", stage(project));
    expect(saved.isError).toBe(false);
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at
       ) VALUES (
         'indexed-row', 'stage', 'sales', 'summarize', ?, 'indexedid', 'Indexed', '[]',
         'static.text', 'indexed', 1, 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
       )`,
    ).run(project);
    const refused = await call(tools, "delete_artifact", { key: `${OWNER_KEY}/indexedid`, project_root: project });
    expect(refused.isError).toBe(true);
    expect(refused.payload.code).toBe("artifact.not_deletable");
    const removed = await call(tools, "delete_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project });
    expect(removed.isError).toBe(false);
    expect(removed.payload).toMatchObject({ key: `${OWNER_KEY}/weekly`, project_root: project });
    const gone = await call(tools, "get_artifact", { key: `${OWNER_KEY}/weekly`, project_root: project });
    expect(gone.payload.code).toBe("artifact.not_found");
  });

  it("accepts artifact groups and rejects an unknown group", () => {
    const granted = parseAgentDefinition({
      id: "x",
      name: "x",
      instructions: "x",
      tools: { stageflow: { groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup", "artifacts.refresh"] } },
    });
    expect(granted.ok).toBe(true);
    expect(grantedStageflowTools({ groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup", "artifacts.refresh"], tools: [] })).toEqual([
      "delete_artifact",
      "get_artifact",
      "refresh_artifact",
      "save_artifact",
    ]);
    const unknown = parseAgentDefinition({
      id: "x",
      name: "x",
      instructions: "x",
      tools: { stageflow: { groups: ["artifacts.nope"] } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.map((issue) => issue.code)).toEqual(["agent.stageflow_group_unknown"]);
  });

  it("serves the tools over the MCP endpoint for the artifacts toolset", async () => {
    const { project, store } = await open();
    const handler = createMcpHttpHandler(
      { manager: {} as never, store, cwd: project, runChangeBus: createRunChangeBus() },
      { mcpStateless: true },
    );
    const server = createServer((req, res) => {
      void handler.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;
    closers.push(async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });

    async function rpc(query: string, method: string, params: Record<string, unknown>) {
      const res = await fetch(mcpUrl(base, query), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const dataLine = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) throw new Error(`no response for ${method}`);
      return JSON.parse(dataLine.slice("data: ".length)) as {
        result?: {
          tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>;
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
      };
    }

    const listed = await rpc("?toolsets=artifacts", "tools/list", {});
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["get_artifact", "save_artifact", "refresh_artifact", "delete_artifact"]));
    expect(names).not.toContain("get_eval");
    for (const name of ["get_artifact", "save_artifact", "refresh_artifact", "delete_artifact"] as const) {
      const tool = listed.result?.tools?.find((entry) => entry.name === name);
      expect(tool?.annotations).toEqual(toolAnnotations(name));
      expect(tool?.description?.includes("/api/")).toBe(false);
      expect(JSON.stringify(tool?.inputSchema).includes("$schema")).toBe(false);
    }

    const saved = await rpc("?toolsets=artifacts", "tools/call", {
      name: "save_artifact",
      arguments: stage(project, { content: "from http" }),
    });
    const savedPayload = JSON.parse(saved.result?.content?.[0]?.text ?? "{}") as { key: string; version: number };
    expect(saved.result?.isError).toBeFalsy();
    expect(savedPayload).toMatchObject({ key: `${OWNER_KEY}/weekly`, version: 1 });
    const read = await rpc("?toolsets=artifacts", "tools/call", {
      name: "get_artifact",
      arguments: { key: `${OWNER_KEY}/weekly`, project_root: project },
    });
    expect(JSON.parse(read.result?.content?.[0]?.text ?? "{}")).toMatchObject({ id: "weekly" });
    const removed = await rpc("?toolsets=artifacts", "tools/call", {
      name: "delete_artifact",
      arguments: { key: `${OWNER_KEY}/weekly`, project_root: project },
    });
    expect(removed.result?.isError).toBeFalsy();
    expect(store).toBeDefined();
  });
});
