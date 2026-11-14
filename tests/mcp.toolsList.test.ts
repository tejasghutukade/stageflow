import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { toolAnnotations } from "../src/mcp/defineTool.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { TOOL_META } from "../src/toolkit/meta.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const TOOLS_LIST_MAX_BYTES = 101_500;

const TOOLS_WITH_UNION_INPUT = new Set([
  "start_run",
  "run_stage",
  "create_dataset",
  "validate_eval",
  "update_eval",
  "validate_catalog_draft",
  "try_eval_case",
]);

type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

function hasSchemaKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSchemaKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "$schema" || hasSchemaKey(child));
}

describe("MCP tools/list", () => {
  let server: Server;
  let home: string;
  let root: string;
  let payload: string;
  let tools: ListedTool[];
  const savedHome = process.env.STAGEFLOW_HOME;

  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-tools-list-home-"));
    root = await mkdtemp(path.join(tmpdir(), "sf-tools-list-root-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: FIXTURES_ROOT,
      rootDir: root,
      store: createRunStore({ rootDir: root }),
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });
    server = started.server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const dataLine = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("no tools/list response");
    tools = (JSON.parse(dataLine.slice("data: ".length)) as { result: { tools: ListedTool[] } }).result.tools;
    payload = JSON.stringify(tools);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedHome === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = savedHome;
    resetGlobalStageflowHomeForTests();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("stays within the byte budget", () => {
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(TOOLS_LIST_MAX_BYTES);
  });

  it("lists exactly the tools in the risk table", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_META).sort());
  });

  it("labels every tool with annotations that match its risk", () => {
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual(toolAnnotations(tool.name));
    }
  });

  it("lists no $schema key in any input schema", () => {
    expect(tools.filter((tool) => hasSchemaKey(tool.inputSchema)).map((tool) => tool.name)).toEqual([]);
  });

  it("names no REST route in any description", () => {
    expect(tools.filter((tool) => tool.description?.includes("/api/")).map((tool) => tool.name)).toEqual([]);
  });

  it("allows a root anyOf only on the known union tools", () => {
    const withRootAnyOf = tools.filter((tool) => "anyOf" in tool.inputSchema).map((tool) => tool.name);
    expect(withRootAnyOf.filter((name) => !TOOLS_WITH_UNION_INPUT.has(name))).toEqual([]);
  });
});
