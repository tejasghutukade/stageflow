import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
import { runRunCommand } from "../src/cli/runCommand.js";
import { reportCliRun } from "../src/cli/runOutput.js";
import { saveHostMcpServer } from "../src/config/mcpHostCatalog.js";
import { loadPipelineFromObject } from "../src/config/loadPipeline.js";
import { listProjectMcpCatalog } from "../src/config/resolveStageMcpServers.js";
import { OAUTH_FILE_KEY_ENV, useHostMcpGrantEnv } from "../src/config/mcpOAuth.js";
import * as mcpOAuth from "../src/config/mcpOAuth.js";
import { runPipelinePreflight } from "../src/preflight/pipelinePreflight.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StagePort } from "../src/agent/port.js";

const sentinel = "u5-run-access-token-sentinel";
const refreshSentinel = "u5-run-refresh-token-sentinel";

const pipeline = {
  id: "host-login",
  stages: [{
    id: "use",
    system_prompt: "hi",
    model: "anthropic/claude-sonnet-4-5",
    mcp: ["docs"],
    io: {
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
    },
  }],
};

const prev = {
  home: process.env.STAGEFLOW_HOME,
  agent: process.env.PI_CODING_AGENT_DIR,
  key: process.env[OAUTH_FILE_KEY_ENV],
};

let home: string;
let root: string;

afterEach(() => {
  if (prev.home === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prev.home;
  if (prev.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prev.agent;
  if (prev.key === undefined) delete process.env[OAUTH_FILE_KEY_ENV];
  else process.env[OAUTH_FILE_KEY_ENV] = prev.key;
  resetGlobalStageflowHomeForTests();
});

async function isolate(): Promise<void> {
  home = await mkdtemp(path.join(tmpdir(), "sf-u5-home-"));
  root = await mkdtemp(path.join(tmpdir(), "sf-u5-root-"));
  process.env.STAGEFLOW_HOME = home;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  process.env[OAUTH_FILE_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
  resetGlobalStageflowHomeForTests();
  useHostMcpGrantEnv();
  saveHostMcpServer("docs", { url: "https://boards.example/mcp" });
}

async function loaded() {
  return loadPipelineFromObject(pipeline, { cwd: root, projectRoot: root });
}

function mcpCheck(checks: Array<{ kind: string; status: string; server?: string }>) {
  return checks.find((check) => check.kind === "mcp" && check.server === "docs");
}

async function storeGrant(expiresAt: number): Promise<void> {
  await updateMcpOAuthTokensForUrl("docs", "https://boards.example/mcp", {
    accessToken: sentinel,
    refreshToken: refreshSentinel,
    expiresAt,
  }, { credentialStore: "encrypted-file" });
}

describe("project MCP list", () => {
  it("includes stored auth and cached tool names, and usableByStages only for a signed-in console server", async () => {
    await isolate();
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["-y", "secret-bin"], env: { TOKEN: sentinel } },
        proj: { url: "https://secret-host.example/mcp", headers: { Authorization: `Bearer ${sentinel}` } },
      },
    }));
    saveHostMcpServer("u5live", { url: "https://live.example/mcp" });
    saveHostMcpServer("u5old", { url: "https://old.example/mcp" });
    saveHostMcpServer("u5fresh", { url: "https://fresh.example/mcp" });
    const future = Math.floor(Date.now() / 1000) + 3600;
    await updateMcpOAuthTokensForUrl("u5live", "https://live.example/mcp", {
      accessToken: sentinel, refreshToken: refreshSentinel, expiresAt: future,
    }, { credentialStore: "encrypted-file" });
    await updateMcpOAuthTokensForUrl("u5old", "https://old.example/mcp", {
      accessToken: sentinel, refreshToken: refreshSentinel, expiresAt: 1,
    }, { credentialStore: "encrypted-file" });
    await updateMcpOAuthTokensForUrl("proj", "https://secret-host.example/mcp", {
      accessToken: sentinel, refreshToken: refreshSentinel, expiresAt: future,
    }, { credentialStore: "encrypted-file" });
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "mcp-cache.json"), JSON.stringify({
      servers: {
        u5live: {
          tools: [{ name: "list_boards", description: `see ${sentinel} at https://secret-host.example/mcp` }],
          cachedAt: 1,
        },
      },
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const listed = await listProjectMcpCatalog(root);
      const row = (name: string) => listed.servers.find((entry) => entry.name === name);
      expect(row("u5live")).toMatchObject({
        origin: "console", authStatus: "authenticated", tools: ["list_boards"], usableByStages: true,
      });
      expect(row("u5old")).toMatchObject({ origin: "console", authStatus: "expired", usableByStages: false });
      expect(row("u5fresh")).toMatchObject({ origin: "console", authStatus: "not_authenticated", usableByStages: false });
      expect(row("proj")).toMatchObject({ origin: "project", authStatus: "authenticated", usableByStages: false });
      expect(row("local")).toMatchObject({ transport: "stdio", usableByStages: false });
      expect(row("local")).not.toHaveProperty("authStatus");
      const payload = JSON.stringify(listed);
      for (const leaked of [sentinel, refreshSentinel, "secret-host.example", "live.example", "Authorization", "secret-bin"]) {
        expect(payload).not.toContain(leaked);
      }
      for (const key of ["env", "headers", "args", "command", "url"]) {
        expect(payload).not.toContain(`"${key}"`);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("host-login preflight and sf run --json", () => {
  it("stored not_authenticated is needs_auth and sends no token request", async () => {
    await isolate();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await runPipelinePreflight(await loaded(), { projectRoot: root });
      expect(result.ok).toBe(false);
      expect(mcpCheck(result.checks)).toMatchObject({ status: "needs_auth", server: "docs" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain("boards.example");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stored authenticated does not open a connection", async () => {
    await isolate();
    await storeGrant(Math.floor(Date.now() / 1000) + 3600);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await runPipelinePreflight(await loaded(), { projectRoot: root });
      expect(mcpCheck(result.checks)).toMatchObject({ status: "ok", server: "docs" });
      expect(result.checks.some((check) => check.status === "needs_auth")).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain(refreshSentinel);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stored expired is needs_auth and does not refresh", async () => {
    await isolate();
    await storeGrant(1);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await runPipelinePreflight(await loaded(), { projectRoot: root });
      expect(mcpCheck(result.checks)?.status).toBe("needs_auth");
      expect(mcpCheck(result.checks)?.status).not.toBe("connect_failed");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("an unreadable store is connect_failed, not needs_auth", async () => {
    await isolate();
    const status = vi.spyOn(mcpOAuth, "mcpStoredGrantStatus").mockResolvedValue("unavailable");
    try {
      const result = await runPipelinePreflight(await loaded(), { projectRoot: root });
      expect(mcpCheck(result.checks)?.status).toBe("connect_failed");
      expect(mcpCheck(result.checks)?.status).not.toBe("needs_auth");
    } finally {
      status.mockRestore();
    }
  });

  it("sf run --json on a signed-out host-login stage contains needs_auth and no token", async () => {
    await isolate();
    const store = createRunStore({ rootDir: home });
    const agent: StagePort = {
      openStage() {
        throw new Error("stage should not start");
      },
      runStage() {
        throw new Error("stage should not start");
      },
    };
    const manager = new RunManager({ agent, store, cwd: root, projectRoot: root });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { docs: { url: "https://boards.example/mcp" } },
      }));
      const started = await manager.startRun({
        task: { id: "t", goal: "g" },
        pipeline,
        projectRoot: root,
      });
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.code).toBe("needs_auth");
      const stdout: string[] = [];
      const code = await runRunCommand(["--json", "--task", "task.yaml", "--pipeline", "pipeline.yaml"], {
        cwd: root,
        io: { log: (line) => stdout.push(line), error: () => undefined },
        startRun: async () => started,
      });
      expect(code).toBe(1);
      const text = stdout.join("\n");
      const parsed = JSON.parse(text) as { code?: string; reason?: string };
      expect(parsed.code).toBe("needs_auth");
      expect(parsed.reason).toContain("needs_auth");
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain("boards.example");
      expect(text).not.toMatch(/access_token|refresh_token|Bearer /);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await store.listRuns()).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      await store.close();
    }
  });

  it("keeps stage failure codes distinct in sf run --json", async () => {
    for (const code of ["needs_auth", "insufficient_scope", "connect_failed", "oauth_backend_unsupported"] as const) {
      const stdout: string[] = [];
      const exit = await reportCliRun(
        {
          kind: "completion",
          result: { ok: false, outcome: "failed", runId: "r", runDir: "/tmp/r", reason: code },
        },
        { json: true, io: { log: (line) => stdout.push(line), error: () => undefined } },
      );
      expect(exit).toBe(1);
      const parsed = JSON.parse(stdout.join("\n")) as { code?: string; reason?: string };
      expect(parsed.reason).toBe(code);
      expect(parsed.code).toBe(code);
    }
    const stdout: string[] = [];
    await reportCliRun(
      {
        kind: "completion",
        result: { ok: false, outcome: "failed", runId: "r", runDir: "/tmp/r", reason: "stage boom" },
      },
      { json: true, io: { log: (line) => stdout.push(line), error: () => undefined } },
    );
    expect(JSON.parse(stdout.join("\n"))).not.toHaveProperty("code");
  });
});
