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
import { TOOL_META, toolsInToolset } from "../src/toolkit/meta.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { MCP_TOOLSETS_ALL_QUERY, mcpUrl } from "./helpers/mcpCall.js";

/**
 * Measured 2026-11-27 after run_stats: 48,011 bytes for 63 tools. Cap 48,250 (about 240 bytes of headroom).
 * Core payload still fits 18,200; that cap was not raised.
 */
const TOOLS_LIST_MAX_BYTES = 48_250;

/** Measured 2026-11-14 after Plan 3 core toolsets: 17,918 bytes for 17 tools (≤ 20,269 = 20% of 101,347 baseline). */
const CORE_TOOLS_LIST_MAX_BYTES = 18_200;

const CORE_TOOL_NAMES = [...toolsInToolset("core")].sort();

const APPENDIX_TOOL_NAMES = [
  "get_started",
  "list_catalog",
  "validate",
  "read_pipeline",
  "write_pipeline",
  "write_stage",
  "write_task",
  "import_task",
  "probe_project_mcp",
  "start_run",
  "get_run",
  "run_stats",
  "get_stage",
  "run_files",
  "wait_run",
  "stage_action",
  "cancel_run",
  "abandon_stage",
  "delete_runs",
  "list_waiting",
  "answer_gate",
  "decide_feedback_loop",
  "get_trigger",
  "save_trigger",
  "fire_trigger",
  "get_agent",
  "get_agent_session",
  "save_agent",
  "set_agent_enabled",
  "archive_agent",
  "agent_chat",
  "stop_agent_session",
  "decide_agent_action",
  "get_function",
  "save_function",
  "test_function",
  "delete_function",
  "get_connection",
  "save_connection",
  "test_connection",
  "remove_connection",
  "get_memory",
  "save_memory",
  "delete_memory_card",
  "get_eval",
  "save_eval",
  "save_dataset",
  "get_eval_run",
  "get_eval_results",
  "compare_eval_runs",
  "get_eval_failures",
  "review_eval_results",
  "run_eval",
  "try_eval_case",
  "sort_eval_failures",
  "calibrate_eval_grader",
  "cancel_eval_run",
  "delete_eval_run",
  "get_artifact",
  "save_artifact",
  "refresh_artifact",
  "delete_artifact",
  "promote_artifact",
] as const;

const TOOLS_WITH_UNION_INPUT = new Set<string>([]);

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
  let corePayload: string;
  let coreTools: ListedTool[];
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
    const base = `http://127.0.0.1:${address.port}`;
    const listTools = async (query: string) => {
      const res = await fetch(mcpUrl(base, query), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const dataLine = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) throw new Error("no tools/list response");
      return (JSON.parse(dataLine.slice("data: ".length)) as { result: { tools: ListedTool[] } }).result.tools;
    };
    tools = await listTools(MCP_TOOLSETS_ALL_QUERY);
    payload = JSON.stringify(tools);
    coreTools = await listTools("");
    corePayload = JSON.stringify(coreTools);
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

  it("bare /mcp stays within the core byte budget", () => {
    expect(Buffer.byteLength(corePayload)).toBeLessThanOrEqual(CORE_TOOLS_LIST_MAX_BYTES);
  });

  it("bare /mcp lists exactly the 18 core tools", () => {
    expect(coreTools.map((tool) => tool.name).sort()).toEqual(CORE_TOOL_NAMES);
    expect(coreTools).toHaveLength(18);
  });

  it("lists exactly the 63 Appendix tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...APPENDIX_TOOL_NAMES].sort());
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_META).sort());
    expect(tools).toHaveLength(63);
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
    expect(withRootAnyOf).toEqual([]);
  });
});
