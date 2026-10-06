import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEBUG_RUN_USAGE,
  runDebugRunCommand,
} from "../src/cli/debugRunCommand.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { clearNamedSecretsForTests } from "../src/logging/namedSecrets.js";
import { encodeStreamLogHeader } from "../src/runtime/stageStreamLog.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildDebugBundle } from "../src/runstore/debugBundle.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { attemptStreamLogPath } from "../src/runstore/workspaceLayout.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";

const READ = "r".repeat(32);
const DRIVE = "d".repeat(32);
const SECRET_TOKEN = "ghp_DebugBundleSecretTokenXX";

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function seedFailedRun(options?: {
  withSecretEvent?: boolean;
  streamBytes?: number;
}): Promise<{ runId: string; store: ReturnType<typeof createRunStore> }> {
  const store = createRunStore({ rootDir: globalStageflowHome() });
  const created = await store.createRun({
    pipelineId: "test-pipeline",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
    pipelineDag: linearCompatDagSnapshot(["stage-a"]),
    runManifest: {
      manifest_version: 1,
      run_id: "pending",
      created_at: new Date().toISOString(),
      host: {
        stageflow_version: "0.24.0",
        build_sha: "test",
        image_digest: null,
        schema_version: 6,
      },
      caller: { caller_id: "default", surface: "cli" },
      binding: { kind: "unbound" },
      pipeline: {
        source: "path",
        path: null,
        bytes_sha256: "a",
        body: null,
      },
      task: {
        source: "inline",
        path: null,
        bytes_sha256: "b",
        body: "id: a\n",
      },
      skills: [],
      stages: [],
      toolchain: [],
    },
  });

  await store.ensureStageWorkspace(created.runId, "stage-a");
  await store.createStageExecution(created.runId, "stage-a");
  await store.appendStageEvent(created.runId, "stage-a", {
    event: "started",
  });
  if (options?.withSecretEvent) {
    await store.appendStageEvent(created.runId, "stage-a", {
      event: "note",
      detail: `token=${SECRET_TOKEN}`,
    });
  }
  await store.appendStageEvent(created.runId, "stage-a", {
    event: "failed",
  });
  await store.upsertVerificationCheckResult(created.runId, "stage-a", {
    check_id: "c1",
    check_type: "command",
    status: "failed",
    evidence: {
      kind: "command",
      stdout: options?.withSecretEvent
        ? `auth ${SECRET_TOKEN}\n`
        : "fail stdout\n",
      stderr: "fail stderr\n",
    },
  });

  const workspaceDir = store.getWorkspaceDir(created.runId);
  const streamPath = attemptStreamLogPath(workspaceDir, "stage-a", 1);
  await mkdir(path.dirname(streamPath), { recursive: true });
  const body =
    options?.streamBytes !== undefined
      ? "x".repeat(options.streamBytes)
      : "stream-line-1\nstream-line-2\n";
  await writeFile(
    streamPath,
    `${encodeStreamLogHeader(0)}${body}`,
    "utf8",
  );

  await store.updateRunStatus(created.runId, "failed");
  return { runId: created.runId, store };
}

describe("runDebugRunCommand", () => {
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-debug-home-"));
    clearNamedSecretsForTests();
  });

  afterEach(() => {
    clearNamedSecretsForTests();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("prints USAGE on --help", async () => {
    const stderr: string[] = [];
    const code = await runDebugRunCommand(["--help"], {
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });
    expect(code).toBe(0);
    expect(stderr.join("\n")).toContain(DEBUG_RUN_USAGE.split("\n")[0]);
  });

  it("builds a bundle with manifest, events, verification, and diff section", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-debug-run-"));
    const { runId } = await seedFailedRun();

    const stdout: string[] = [];
    const code = await runDebugRunCommand([runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: (line) => stdout.push(line),
        error: () => undefined,
      },
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("\n")) as {
      run_id: string;
      status: string;
      run_manifest: { manifest_version: number } | null;
      stage_events: { stages: Array<{ stage_id: string }> };
      verification: { stages: Array<{ stage_id: string; attempts: unknown[] }> };
      diff: { available: boolean };
      stream_log_tails: { tails: Array<{ stage_id: string; text: string }> };
      host_config: { maxConcurrentRuns: number };
    };
    expect(parsed.run_id).toBe(runId);
    expect(parsed.status).toBe("failed");
    expect(parsed.run_manifest?.manifest_version).toBe(1);
    expect(parsed.stage_events.stages.map((s) => s.stage_id)).toEqual([
      "stage-a",
    ]);
    expect(parsed.verification.stages[0]?.stage_id).toBe("stage-a");
    expect(parsed.verification.stages[0]?.attempts.length).toBeGreaterThan(0);
    expect(parsed.diff.available).toBe(false);
    expect(parsed.stream_log_tails.tails[0]?.text).toContain("stream-line-1");
    expect(parsed.host_config.maxConcurrentRuns).toBeGreaterThan(0);
  });

  it("writes JSON to --out", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-debug-out-"));
    const { runId } = await seedFailedRun();
    const stderr: string[] = [];
    const code = await runDebugRunCommand([runId, "--out", "bundle.json"], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: () => undefined,
        error: (line) => stderr.push(line),
      },
    });
    expect(code).toBe(0);
    expect(stderr.join("\n")).toMatch(/Wrote .*bundle\.json/);
    const contents = await readFile(
      path.join(projectRoot, "bundle.json"),
      "utf8",
    );
    const parsed = JSON.parse(contents) as { run_id: string };
    expect(parsed.run_id).toBe(runId);
  });

  it("marks oversize stream and event sections with truncation markers", async () => {
    const { runId, store } = await seedFailedRun({ streamBytes: 8_000 });
    const bundle = await buildDebugBundle(store, runId, {
      streamLogMaxBytes: 64,
      eventsMaxBytes: 32,
    });
    const streamTail = bundle.stream_log_tails.tails[0];
    expect(streamTail?.truncated).toBe(true);
    expect(streamTail?.original_bytes).toBeGreaterThan(64);
    expect(streamTail?.text.length).toBeLessThanOrEqual(64);
    expect(bundle.stage_events.truncated).toBe(true);
    expect(bundle.stage_events.original_bytes).toBeGreaterThan(32);
    expect(bundle.stage_events.stages).toEqual([]);
  });

  it("redacts secret values from the whole bundle", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-debug-redact-"));
    const { runId } = await seedFailedRun({ withSecretEvent: true });
    const stdout: string[] = [];
    const code = await runDebugRunCommand([runId], {
      cwd: projectRoot,
      projectRoot,
      io: {
        log: (line) => stdout.push(line),
        error: () => undefined,
      },
    });
    expect(code).toBe(0);
    const raw = stdout.join("\n");
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).toMatch(/\[redacted\]/);
  });

  it("GET /api/runs/:id/debug-bundle returns the same shape with read scope", async () => {
    const { runId, store } = await seedFailedRun();
    const home = globalStageflowHome();
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN: DRIVE,
      STAGEFLOW_READ_TOKEN: READ,
    });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: home,
      rootDir: home,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: tokens,
    });
    try {
      const denied = await fetch(
        `${started.url}/api/runs/${encodeURIComponent(runId)}/debug-bundle`,
      );
      expect(denied.status).toBe(401);

      const ok = await fetch(
        `${started.url}/api/runs/${encodeURIComponent(runId)}/debug-bundle`,
        { headers: { Authorization: `Bearer ${READ}` } },
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        run_id: string;
        run_manifest: unknown;
        stage_events: unknown;
        verification: unknown;
        diff: unknown;
        stream_log_tails: unknown;
        host_config: unknown;
      };
      expect(body.run_id).toBe(runId);
      expect(body.run_manifest).toBeDefined();
      expect(body.stage_events).toBeDefined();
      expect(body.verification).toBeDefined();
      expect(body.diff).toBeDefined();
      expect(body.stream_log_tails).toBeDefined();
      expect(body.host_config).toBeDefined();
    } finally {
      await closeServer(started.server);
    }
  });
});
