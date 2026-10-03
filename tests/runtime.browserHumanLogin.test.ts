import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent, type FakeAgentBehavior } from "../src/agent/fakeAgent.js";
import type { AgentPort } from "../src/agent/port.js";
import { runStageViaOpen } from "../src/agent/port.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";

type Call = { args: string[]; env: Record<string, string> };

const FIXTURE = path.resolve("tests/fixtures/pipelines/browser-human-login.pipeline.yaml");
const LOGGED_IN = "https://app.example.test/home/feed";
const LOGGED_OUT = "https://app.example.test/login?next=%2Fhome";
const savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-hl-"));
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

const ok = (payload: unknown = {}) => ({ status: "success", summary: "ok", artifacts: [], payload });
const confirmGate = (message = "Log in in the open window, then confirm.") => ({ kind: "confirm", message, id: "gate-1" });

type Plan = Record<string, FakeAgentBehavior[]>;

async function waitFor(cond: () => boolean | Promise<boolean>) {
  const t = Date.now();
  while (Date.now() - t < 8000) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
}

function setup(options: {
  plan: Plan;
  /** Final URL the Nth `open` lands on; the last one repeats. */
  urls: string[];
  display?: { hasDisplay: boolean; docker: boolean };
  locks?: ReturnType<typeof createInMemoryProfileLock>;
}) {
  const calls: Call[] = [];
  const prompts: Record<string, string[]> = {};
  const used: Record<string, number> = {};
  let urlIndex = 0;
  const runner: BrowserRunner = async (args, env) => {
    calls.push({ args, env: { ...env } });
    if (args[0] === "get" && args[1] === "cdp-url") return { code: 0, stdout: "ws://127.0.0.1:41000/devtools/browser/anchor\n" };
    if (args[0] === "open" && args[1] !== "about:blank") urlIndex += 1;
    if (args[0] === "get" && args[1] === "url") {
      const url = options.urls[Math.min(urlIndex - 1, options.urls.length - 1)]!;
      return { code: 0, stdout: `${url}\n` };
    }
    return { code: 0 };
  };
  const agent: AgentPort = {
    openStage(input) {
      const id = input.stageId ?? input.stage.id;
      (prompts[id] ??= []).push(input.stage.system_prompt);
      const behaviors = options.plan[id] ?? [];
      const behavior = behaviors[Math.min(used[id] ?? 0, behaviors.length - 1)] ?? { type: "never_emit" as const };
      used[id] = (used[id] ?? 0) + 1;
      return new FakeAgent(behavior).openStage(input);
    },
    async runStage(input) {
      return runStageViaOpen(agent, input);
    },
  };
  const locks = options.locks ?? createInMemoryProfileLock();
  const support: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
    profiles: createLocalProfileStore(),
    runner,
    locks,
    closeWaitMs: 100,
    socketRoot: path.join(root, "sock"),
    loginCheck: { settleMs: 0 },
    ...(options.display !== undefined ? { display: () => options.display! } : {}),
  };
  const store = createRunStore({ rootDir: path.join(root, "store") });
  const manager = new RunManager({ agent, store, cwd: root, browser: support });
  return { calls, prompts, locks, manager, store, support };
}

async function start(s: ReturnType<typeof setup>) {
  const started = await s.manager.startRun({ task: path.resolve("tests/fixtures/tasks/sample.task.yaml"), pipeline: FIXTURE });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const status = async (id: string) =>
    (await s.store.readRun(started.runId)).stages.find((x) => x.stage_id === id);
  return { started, status };
}

const closes = (calls: Call[]) => calls.filter((c) => c.args[0] === "close");

describe("browser human login stage", () => {
  const checkOut = ok({ logged_in: false, url: LOGGED_OUT });

  it("gate carries Host-injected handoff, site and profile name (no path); agent cannot forge it", async () => {
    const s = setup({
      plan: {
        check: [{ type: "emit", envelope: checkOut }],
        login: [
          {
            type: "wait_then_emit",
            waitRequests: [{ ...confirmGate(), handoff: { kind: "live_view", url: "https://evil.test/" }, site: "evil.test" }],
            envelope: ok(),
          },
        ],
        work: [{ type: "emit", envelope: ok() }],
      },
      urls: [LOGGED_OUT, LOGGED_OUT, LOGGED_IN],
    });
    const { started, status } = await start(s);
    await waitFor(async () => (await status("login"))?.status === "waiting_for_input");
    const detail = await s.store.readRun(started.runId);
    const prompt = detail.stages.find((x) => x.stage_id === "login")!.pending_prompt as Record<string, unknown>;
    expect(prompt).toMatchObject({
      kind: "confirm",
      handoff: { kind: "local_window" },
      site: "app.example.test",
      profile: "acct",
    });
    expect(JSON.stringify(prompt)).not.toContain(root);
    expect(JSON.stringify(prompt)).not.toContain("evil.test");
    const d = await s.manager.deliverAnswer(started.runId, "login", { promptId: String(prompt.id), kind: "confirm", decision: "accept" });
    expect(d.ok).toBe(true);
    await started.done;
  });

  it("opens the login page headed; window and lock stay while the operator has not answered", async () => {
    const s = setup({
      plan: {
        check: [{ type: "emit", envelope: checkOut }],
        login: [{ type: "wait_then_emit", waitRequests: [confirmGate()], envelope: ok() }],
        work: [{ type: "emit", envelope: ok() }],
      },
      urls: [LOGGED_OUT, LOGGED_OUT, LOGGED_IN],
    });
    const { started, status } = await start(s);
    await waitFor(async () => (await status("login"))?.status === "waiting_for_input");
    await new Promise((r) => setTimeout(r, 150));

    const loginEnv = JSON.parse(
      await readFile(path.join(s.store.getWorkspaceDir(started.runId), "stages", "login", "browser-env.json"), "utf8"),
    ) as Record<string, string>;
    expect(loginEnv.AGENT_BROWSER_HEADED).toBe("1");
    const opens = s.calls.filter((c) => c.args[0] === "open" && c.args[1] !== "about:blank" && c.env.AGENT_BROWSER_HEADED === "1");
    expect(opens.map((c) => c.args[1])).toEqual(["https://app.example.test/login"]);
    expect(s.prompts.login![0]).toMatch(/Human login/);

    expect(closes(s.calls).filter((c) => c.env.AGENT_BROWSER_HEADED === "1")).toEqual([]);
    expect(await s.locks.holder({ scope: "local", name: "acct" })).toEqual({ runId: started.runId, stageId: "login" });

    const pending = (await s.store.readRun(started.runId)).stages.find((x) => x.stage_id === "login")!.pending_prompt!;
    await s.manager.deliverAnswer(started.runId, "login", { promptId: pending.id, kind: "confirm", decision: "accept" });
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect((await status("work"))?.status).toBe("succeeded");
    expect(await s.locks.holder({ scope: "local", name: "acct" })).toBeUndefined();
  });

  it("wrong confirm: Host re-check still logged out, stage runs again; right confirm proceeds", async () => {
    const s = setup({
      plan: {
        check: [{ type: "emit", envelope: checkOut }],
        login: [{ type: "wait_then_emit", waitRequests: [confirmGate()], envelope: ok() }],
        work: [{ type: "emit", envelope: ok() }],
      },
      // check page, login page open, verify #1 (still out), login page again, verify #2 (in)
      urls: [LOGGED_OUT, LOGGED_OUT, LOGGED_OUT, LOGGED_OUT, LOGGED_IN],
    });
    const { started, status } = await start(s);
    const answerFor = async (attempt: number) => {
      await waitFor(async () => {
        const st = await status("login");
        return st?.status === "waiting_for_input" && st.attempt_count === attempt;
      });
      const pending = (await status("login"))!.pending_prompt!;
      await s.manager.deliverAnswer(started.runId, "login", { promptId: pending.id, kind: "confirm", decision: "accept" });
    };
    await answerFor(1);
    await answerFor(2);
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect((await status("login"))?.attempt_count).toBe(2);
    expect((await status("work"))?.status).toBe("succeeded");
    const loginOpens = s.calls.filter((c) => c.args[0] === "open" && c.args[1] === "https://app.example.test/login");
    expect(loginOpens).toHaveLength(2);
  });

  it("no display: fails before the agent starts with the live view message; Docker adds a hint", async () => {
    for (const docker of [false, true]) {
      const s = setup({
        plan: { check: [{ type: "emit", envelope: checkOut }], login: [{ type: "emit", envelope: ok() }] },
        urls: [LOGGED_OUT],
        display: { hasDisplay: false, docker },
      });
      const { started, status } = await start(s);
      const result = await started.done;
      expect(result.ok).toBe(false);
      expect(s.prompts.login).toBeUndefined();
      const reason = result as { reason: string };
      expect(reason.reason).toContain(
        "A visible browser is needed for login, but this Host has no screen. A live view handoff is not available yet.",
      );
      expect(/Docker/.test(reason.reason)).toBe(docker);
    }
  });

  it("non-browser stage gate has no handoff, site or profile", async () => {
    const s = setup({
      plan: {
        check: [{ type: "emit", envelope: ok({ logged_in: true, url: LOGGED_IN }) }],
        work: [{ type: "wait_then_emit", waitRequests: [{ ...confirmGate("go?"), handoff: { kind: "local_window" } }], envelope: ok() }],
      },
      urls: [LOGGED_IN],
    });
    const { started, status } = await start(s);
    await waitFor(async () => (await status("work"))?.status === "waiting_for_input");
    const prompt = (await status("work"))!.pending_prompt as Record<string, unknown>;
    expect(prompt.handoff).toBeUndefined();
    expect(prompt.site).toBeUndefined();
    expect(prompt.profile).toBeUndefined();
    await s.manager.deliverAnswer(started.runId, "work", { promptId: String(prompt.id), kind: "confirm", decision: "accept" });
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect((await status("login"))?.status).toBe("skipped");
  });
});
