import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createMemoryAuditSink, type AuditSink } from "../src/browser/auditSink.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { listArtifactNames } from "../src/runstore/workspaceLayout.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

const COOKIE = "AQEDAR0v3xYz9abcDEF1234567890ghIJKlmnOPqrSTuv";
let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-bp-"));
  home = path.join(root, "home");
  const manifest = path.join(root, "toolchain.json");
  await writeFile(
    manifest,
    JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }),
  );
  for (const k of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) saved[k] = process.env[k];
  process.env.STAGEFLOW_HOME = home;
  process.env.STAGEFLOW_TOOLCHAIN_MANIFEST = manifest;
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetGlobalStageflowHomeForTests();
  await rm(root, { recursive: true, force: true });
});

const io = { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } };
const pipeline = (browser: unknown) =>
  ({
    id: "bp",
    stages: [{ id: "work", system_prompt: "x", model: "anthropic/claude-sonnet-4-5", io, browser }],
  }) as unknown as InlinePipelineDefinition;

function setup(audit: AuditSink, blockedSites: string[] = []) {
  const support: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
    profiles: createLocalProfileStore({ audit }),
    runner: async () => ({ code: 0 }),
    closeWaitMs: 200,
    audit,
    blockedSites,
  };
  const store = createRunStore({ rootDir: root });
  return { support, store };
}

const emit = {
  type: "emit" as const,
  envelope: {
    status: "success",
    summary: `cookies dumped: Cookie: li_at=${COOKIE}`,
    artifacts: [],
    payload: { raw: `{"name":"li_at","value":"${COOKIE}","domain":".x.com"}` },
  },
};

describe("browser stage with cookie-looking output", () => {
  it("keeps cookie values and profile paths out of envelopes, run state and artifacts; audits use", async () => {
    const audit = createMemoryAuditSink();
    const { support, store } = setup(audit);
    const started = await startPipeline({
      agent: scriptedFakeAgent([emit]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: pipeline({ profile: "acct" }),
      cwd: root,
      executionMode: "inprocess",
      browser: support,
    } as never);
    await started.done;

    const detail = await store.readRun(started.runId);
    const envelope = await store.readEnvelope(started.runId, "work");
    const state = JSON.stringify({ detail, envelope });
    expect((await store.readRunMeta(started.runId)).status).toBe("succeeded");
    expect(state).not.toContain(COOKIE);
    expect(state).not.toContain(home);
    expect(state).not.toContain("browser-env");

    const workspace = store.getWorkspaceDir(started.runId);
    const artifacts = await listArtifactNames(workspace, "work", 1);
    expect(artifacts.join("\n")).not.toContain("browser-env");

    expect(audit.records.map((r) => r.event)).toEqual(["profile_created", "profile_used"]);
    expect(audit.records[1]).toMatchObject({ profile: "acct", runId: started.runId, stageId: "work" });
    expect(JSON.stringify(audit.records)).not.toContain(home);
    const envFile = await readFile(path.join(workspace, "stages", "work", "browser-env.json"), "utf8");
    expect(envFile).toContain("AGENT_BROWSER_PROFILE");
  });

  it("stores cookie-like text unchanged for a NON-browser stage", async () => {
    const { store } = setup(createMemoryAuditSink());
    const started = await startPipeline({
      agent: scriptedFakeAgent([emit]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: pipeline(undefined),
      cwd: root,
      executionMode: "inprocess",
    } as never);
    await started.done;
    const envelope = await store.readEnvelope(started.runId, "work");
    expect(envelope?.summary).toContain(COOKIE);
    expect(JSON.stringify(envelope?.payload)).toContain(COOKIE);
  });

  it("fails the stage with a clear error when allow_domains hits a Host-blocked site", async () => {
    const audit = createMemoryAuditSink();
    const { support, store } = setup(audit, ["blocked.example"]);
    const started = await startPipeline({
      agent: scriptedFakeAgent([emit]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: pipeline({ allow_domains: ["app.blocked.example"] }),
      cwd: root,
      executionMode: "inprocess",
      browser: support,
    } as never);
    const result = await started.done;
    expect((await store.readRunMeta(started.runId)).status).toBe("failed");
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason?: string }).reason).toMatch(
      /Stage "work".*app\.blocked\.example.*blocked by Host policy \(browser\.blocked_sites\)/,
    );
    expect(audit.records).toEqual([]);
  });
});
