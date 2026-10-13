import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../src/agent/fakeAgent.js";
import type { StagePort } from "../src/agent/port.js";
import { runStageViaOpen } from "../src/agent/port.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";

type Call = { args: string[]; env: Record<string, string> };

const FIXTURE = path.resolve("tests/fixtures/pipelines/browser-login-check.pipeline.yaml");
const savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-lc-"));
  for (const key of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) savedEnv[key] = process.env[key];
  const manifest = path.join(root, "toolchain.json");
  await writeFile(
    manifest,
    JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }),
  );
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  process.env.STAGEFLOW_TOOLCHAIN_MANIFEST = manifest;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
  await rm(root, { recursive: true, force: true });
});

const ok = (payload: unknown) => ({ status: "success", summary: "ok", artifacts: [], payload });

function runnerFor(finalUrl: string, calls: Call[]): BrowserRunner {
  return async (args, env) => {
    calls.push({ args, env: { ...env } });
    if (args[0] === "get" && args[1] === "cdp-url") return { code: 0, stdout: "ws://127.0.0.1:41000/devtools/browser/anchor\n" };
    if (args[0] === "get" && args[1] === "url") return { code: 0, stdout: `${finalUrl}\n` };
    return { code: 0 };
  };
}

type Scripted = Record<string, unknown>;

function agentFor(emits: Scripted, prompts: Record<string, string>): StagePort {
  const agent: StagePort = {
    openStage(input) {
      prompts[input.stageId ?? input.stage.id] = input.stage.system_prompt;
      const envelope = emits[input.stageId ?? input.stage.id];
      return new FakeAgent(
        envelope === undefined ? { type: "never_emit" } : { type: "emit", envelope },
      ).openStage(input);
    },
    async runStage(input) {
      return runStageViaOpen(agent, input);
    },
  };
  return agent;
}

async function run(finalUrl: string, emits: Scripted) {
  const calls: Call[] = [];
  const prompts: Record<string, string> = {};
  const support: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
    profiles: createLocalProfileStore(),
    runner: runnerFor(finalUrl, calls),
    closeWaitMs: 200,
    socketRoot: path.join(root, "sock"),
    loginCheck: { settleMs: 0 },
  };
  const store = createRunStore({ rootDir: path.join(root, "store") });
  const started = await startPipeline({
    agent: agentFor(emits, prompts),
    store,
    taskYaml: "id: t\ngoal: g\n",
    pipeline: FIXTURE,
    cwd: root,
    executionMode: "inprocess",
    browser: support,
  });
  const result = await started.done;
  const detail = await store.readRun(started.runId);
  const status = (id: string) => detail.stages.find((s) => s.stage_id === id)?.status;
  const stored = JSON.parse(
    await readFile(
      path.join(store.getWorkspaceDir(started.runId), "stages", "check", "browser-env.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  return { calls, prompts, result, status, stored };
}

const LOGGED_IN = "https://app.example.test/home/feed";
const LOGGED_OUT = "https://app.example.test/login?next=%2Fhome";
const UNKNOWN = "https://app.example.test/verify-its-you";

describe("browser login check", () => {
  it("logged-in profile: result handed to the agent, login skipped, work still runs", async () => {
    const { calls, prompts, result, status, stored } = await run(LOGGED_IN, {
      check: ok({ logged_in: true, url: LOGGED_IN }),
      work: ok({}),
    });
    expect(result.ok).toBe(true);
    expect(status("check")).toBe("succeeded");
    expect(status("login")).toBe("skipped");
    expect(status("work")).toBe("succeeded");
    expect(prompts.check).toContain(JSON.stringify({ logged_in: true, url: LOGGED_IN }));
    expect(calls.find((c) => c.args[0] === "open" && c.args[1] !== "about:blank")?.args[1]).toBe("https://app.example.test/home");
    for (const c of calls.filter((x) => x.env.AGENT_BROWSER_PROFILE === undefined)) expect(c.env).toEqual(stored);
    expect(calls.filter((c) => c.args[0] === "open" && c.args[1] !== "about:blank")).toHaveLength(1);
  });

  it("logged-out profile: routes through login to work", async () => {
    const { prompts, result, status } = await run(LOGGED_OUT, {
      check: ok({ logged_in: false, url: LOGGED_OUT }),
      login: ok({ logged_in: true, url: LOGGED_IN }),
      work: ok({}),
    });
    expect(result.ok).toBe(true);
    expect(prompts.check).toContain(JSON.stringify({ logged_in: false, url: LOGGED_OUT }));
    expect(status("login")).toBe("succeeded");
    expect(status("work")).toBe("succeeded");
  });

  it("fails the stage when the envelope disagrees with the Host result", async () => {
    const lie = await run(LOGGED_OUT, { check: ok({ logged_in: true, url: LOGGED_OUT }), work: ok({}) });
    expect(lie.status("check")).toBe("failed");
    expect(lie.status("work")).not.toBe("succeeded");

    const wrongUrl = await run(LOGGED_IN, { check: ok({ logged_in: true, url: "https://elsewhere.test/" }), work: ok({}) });
    expect(wrongUrl.status("check")).toBe("failed");
  });

  it("unknown page: agent decides, Host only checks boolean and url", async () => {
    const decided = await run(UNKNOWN, {
      check: ok({ logged_in: false, url: UNKNOWN }),
      login: ok({ logged_in: true, url: LOGGED_IN }),
      work: ok({}),
    });
    expect(decided.prompts.check).toMatch(/unknown/);
    expect(decided.prompts.check).toMatch(/browser skill/);
    expect(decided.status("check")).toBe("succeeded");
    expect(decided.status("login")).toBe("succeeded");

    const badUrl = await run(UNKNOWN, { check: ok({ logged_in: true, url: "https://x.test/" }), work: ok({}) });
    expect(badUrl.status("check")).toBe("failed");
  });
});
