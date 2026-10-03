import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import type { BrowserRunner } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { LOCAL_BROWSER_SCOPE } from "../src/browser/profileStore.js";
import {
  BROWSER_EXIT,
  BROWSER_USAGE,
  runBrowserCommand,
  type BrowserCommandDeps,
} from "../src/cli/browserCommand.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

let home: string;
let socketRoot: string;
let audit: ReturnType<typeof createMemoryAuditSink>;
let out: string[];
let err: string[];
let calls: string[][];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-cli-browser-"));
  socketRoot = await mkdtemp(path.join(tmpdir(), "sfb-t-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  audit = createMemoryAuditSink();
  out = [];
  err = [];
  calls = [];
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(socketRoot, { recursive: true, force: true });
});

function scriptedRunner(urls: string[]): BrowserRunner {
  let i = 0;
  return async (args) => {
    calls.push(args);
    if (args[0] === "get" && args[1] === "url") {
      const url = urls[Math.min(i, urls.length - 1)];
      i += 1;
      return url === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `${url}\n` };
    }
    return { code: 0, stdout: "" };
  };
}

function deps(over: Partial<BrowserCommandDeps> = {}): Partial<BrowserCommandDeps> {
  return {
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    store: createLocalProfileStore({ audit }),
    host: createLocalBrowserHost({
      platform: "darwin",
      socketRoot,
      emptyConfigPath: path.join(home, "empty.json"),
    }),
    locks: createInMemoryProfileLock(),
    runner: scriptedRunner(["https://site.test/home"]),
    display: () => ({ hasDisplay: true, docker: false }),
    isRunLive: async () => true,
    auditLastUsed: async () => ({}),
    interactive: false,
    sleep: async () => undefined,
    closeWaitMs: 50,
    loginCheck: { waitMs: 1, settleMs: 0 },
    ...over,
  };
}

async function mkProfile(name: string, d: Partial<BrowserCommandDeps>) {
  await d.store!.open({ scope: LOCAL_BROWSER_SCOPE, name });
}

const CHECK = ["--url", "https://site.test/feed", "--logged-in", "https://site.test/home*", "--logged-out", "*/login*"];

describe("sf browser profiles", () => {
  it("lists names and last use without paths", async () => {
    const d = deps({ auditLastUsed: async () => ({ work: "2030-01-01T00:00:00.000Z" }) });
    await mkProfile("work", d);
    await mkProfile("alt", d);
    expect(await runBrowserCommand(["profiles"], d)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("work\t2030-01-01T00:00:00.000Z");
    expect(text).toMatch(/^alt\t/m);
    expect(text).not.toContain(home);
    out.length = 0;
    expect(await runBrowserCommand(["profiles", "--json"], d)).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    expect(doc.profiles.map((p: { name: string }) => p.name)).toEqual(["alt", "work"]);
    expect(JSON.stringify(doc)).not.toContain(home);
  });
});

describe("sf browser status", () => {
  it("reports a free profile and an absent one", async () => {
    const d = deps();
    await mkProfile("work", d);
    expect(await runBrowserCommand(["status", "work", "--json"], d)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({
      name: "work",
      exists: true,
      locked: false,
      lock: null,
      session_open: false,
    });
    out.length = 0;
    await runBrowserCommand(["status", "nope", "--json"], d);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ exists: false, locked: false });
  });

  it("reports the lock holder and an open session", async () => {
    const d = deps();
    await mkProfile("work", d);
    await d.locks!.acquire({ scope: LOCAL_BROWSER_SCOPE, name: "work" }, { runId: "run-9", stageId: "scrape" });
    await runBrowserCommand(["status", "work", "--json"], d);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      locked: true,
      lock: { run_id: "run-9", stage_id: "scrape", live: true },
    });
    out.length = 0;
    await runBrowserCommand(["status", "work"], deps({ ...d, sessionOpen: () => true }));
    expect(out.join("\n")).toContain("held by run run-9 stage scrape");
    expect(out.join("\n")).toContain("browser session: open");
  });
});

describe("sf browser check", () => {
  it.each([
    ["https://site.test/home/x", BROWSER_EXIT.ok, true, "logged_in"],
    ["https://site.test/login?next=1", BROWSER_EXIT.loggedOut, false, "logged_out"],
    ["https://site.test/other", BROWSER_EXIT.unknown, null, "unknown"],
  ])("%s exits %i", async (url, code, loggedIn, state) => {
    const d = deps({ runner: scriptedRunner([url]) });
    await mkProfile("work", d);
    expect(await runBrowserCommand(["check", "work", ...CHECK, "--json"], d)).toBe(code);
    expect(JSON.parse(out.join("\n"))).toEqual({ logged_in: loggedIn, url, state });
    expect(calls[0]).toEqual(["open", "https://site.test/feed"]);
    expect(calls.at(-1)).toEqual(["close"]);
  });

  it("uses the stage env scheme and respects --headless", async () => {
    const envs: Record<string, string>[] = [];
    const runner: BrowserRunner = async (args, env) => {
      envs.push(env);
      return { code: 0, stdout: args[0] === "get" ? "https://site.test/home\n" : "" };
    };
    const d = deps({ runner });
    await mkProfile("work", d);
    await runBrowserCommand(["check", "work", ...CHECK, "--headless"], d);
    expect(envs[0]).toMatchObject({ AGENT_BROWSER_SESSION: "sf-work", AGENT_BROWSER_HEADED: "0" });
    expect(envs[0]!.AGENT_BROWSER_PROFILE).toBeTruthy();
    expect(new Set(envs.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(out.join("\n")).toContain("state: logged_in");
  });

  it("refuses while a live run holds the profile, and releases its own lock", async () => {
    const d = deps();
    await mkProfile("work", d);
    await d.locks!.acquire({ scope: LOCAL_BROWSER_SCOPE, name: "work" }, { runId: "run-1", stageId: "s" });
    expect(await runBrowserCommand(["check", "work", ...CHECK], d)).toBe(BROWSER_EXIT.busy);
    expect(err.join("\n")).toMatch(/in use by run run-1/);
    expect(calls).toEqual([]);
    await d.locks!.releaseOwner({ runId: "run-1" });
    expect(await runBrowserCommand(["check", "work", ...CHECK], d)).toBe(0);
    expect(await d.locks!.holder({ scope: LOCAL_BROWSER_SCOPE, name: "work" })).toBeUndefined();
  });

  it("fails clearly for a missing profile and a missing flag, JSON error shape", async () => {
    const d = deps();
    expect(await runBrowserCommand(["check", "ghost", ...CHECK, "--json"], d)).toBe(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ code: "not_found" });
    await mkProfile("work", d);
    expect(await runBrowserCommand(["check", "work", "--url", "https://x.test"], d)).toBe(1);
    expect(err.join("\n")).toMatch(/--logged-in/);
  });
});

describe("sf browser login", () => {
  const args = ["login", "work", "--url", "https://site.test/login", "--logged-in", "https://site.test/home*"];

  it("opens headed and ends when the check passes", async () => {
    const envs: Record<string, string>[] = [];
    const inner = scriptedRunner([
      "https://site.test/login",
      "https://site.test/login",
      "https://site.test/home",
    ]);
    const runner: BrowserRunner = (a, e) => {
      envs.push(e);
      return inner(a, e);
    };
    const d = deps({ runner });
    expect(await runBrowserCommand([...args, "--json"], d)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({
      logged_in: true,
      url: "https://site.test/home",
      state: "logged_in",
    });
    expect(calls[0]).toEqual(["open", "https://site.test/login"]);
    expect(calls.at(-1)).toEqual(["close"]);
    expect(envs[0]!.AGENT_BROWSER_HEADED).toBe("1");
    expect(await d.locks!.holder({ scope: LOCAL_BROWSER_SCOPE, name: "work" })).toBeUndefined();
    expect(audit.records.some((r) => r.event === "profile_created")).toBe(true);
  });

  it("times out with exit 5 and closes the session", async () => {
    const d = deps({ runner: scriptedRunner(["https://site.test/login"]) });
    expect(await runBrowserCommand([...args, "--timeout-sec", "0.01"], d)).toBe(BROWSER_EXIT.notCompleted);
    expect(out.join("\n")).toMatch(/Timed out/);
    expect(calls.at(-1)).toEqual(["close"]);
  });

  it("exits 130 on interrupt and 5 when the window closes", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await runBrowserCommand(args, deps({ signal: controller.signal, runner: scriptedRunner(["https://site.test/login"]) })),
    ).toBe(BROWSER_EXIT.interrupted);
    out.length = 0;
    expect(await runBrowserCommand(args, deps({ runner: scriptedRunner([]) }))).toBe(BROWSER_EXIT.notCompleted);
    expect(out.join("\n")).toMatch(/window was closed/);
  });

  it("fails with the no-screen message", async () => {
    const d = deps({ display: () => ({ hasDisplay: false, docker: true }) });
    expect(await runBrowserCommand(args, d)).toBe(1);
    expect(err.join("\n")).toMatch(/no screen/);
    expect(err.join("\n")).toMatch(/Docker/);
    expect(calls).toEqual([]);
  });
});

describe("sf browser clear", () => {
  async function onDisk(d: Partial<BrowserCommandDeps>) {
    await mkProfile("work", d);
    const handle = await d.store!.open({ scope: LOCAL_BROWSER_SCOPE, name: "work" });
    await mkdir(handle.profileDir, { recursive: true });
    await writeFile(path.join(handle.profileDir, "Cookies"), "secret");
  }

  it("without --yes and no terminal fails and deletes nothing", async () => {
    const d = deps();
    await onDisk(d);
    expect(await runBrowserCommand(["clear", "work"], d)).toBe(1);
    expect(err.join("\n")).toMatch(/--yes/);
    expect(await d.store!.list(LOCAL_BROWSER_SCOPE)).toEqual(["work"]);
  });

  it("asks on a terminal and honours a no", async () => {
    const asked: string[] = [];
    const d = deps({ interactive: true, confirm: async (q) => (asked.push(q), false) });
    await onDisk(d);
    expect(await runBrowserCommand(["clear", "work"], d)).toBe(1);
    expect(asked).toHaveLength(1);
    expect(await d.store!.list(LOCAL_BROWSER_SCOPE)).toEqual(["work"]);
    const yes = deps({ ...d, confirm: async () => true });
    expect(await runBrowserCommand(["clear", "work"], yes)).toBe(0);
    expect(await d.store!.list(LOCAL_BROWSER_SCOPE)).toEqual([]);
  });

  it("--yes closes the session, deletes, and records the audit event", async () => {
    const d = deps();
    await onDisk(d);
    expect(await runBrowserCommand(["clear", "work", "--yes", "--json"], d)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ cleared: true, name: "work" });
    expect(calls).toContainEqual(["close"]);
    expect(await d.store!.list(LOCAL_BROWSER_SCOPE)).toEqual([]);
    expect(audit.records).toContainEqual({ event: "profile_deleted", scope: LOCAL_BROWSER_SCOPE, profile: "work" });
  });

  it("refuses when a live run holds the profile", async () => {
    const d = deps();
    await onDisk(d);
    await d.locks!.acquire({ scope: LOCAL_BROWSER_SCOPE, name: "work" }, { runId: "run-2", stageId: "s" });
    expect(await runBrowserCommand(["clear", "work", "--yes"], d)).toBe(BROWSER_EXIT.busy);
    expect(await d.store!.list(LOCAL_BROWSER_SCOPE)).toEqual(["work"]);
    expect(calls).toEqual([]);
  });
});

describe("sf browser usage", () => {
  it("prints help and rejects unknown subcommands", async () => {
    expect(await runBrowserCommand(["--help"], deps())).toBe(0);
    expect(out.join("\n")).toContain("sf browser clear");
    expect(await runBrowserCommand(["wat"], deps())).toBe(1);
  });

  it("is routed from the top-level CLI and listed in --help", { timeout: 20_000 }, () => {
    const run = (a: string[]) =>
      spawnSync(process.execPath, [tsxCli, path.join(root, "src", "cli.ts"), ...a], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, STAGEFLOW_HOME: home },
      });
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/sf browser profiles/);
    expect(help.stdout).toContain(BROWSER_USAGE.slice(0, 20));
    const profiles = run(["browser", "profiles", "--json"]);
    expect(profiles.status).toBe(0);
    expect(JSON.parse(profiles.stdout)).toEqual({ profiles: [] });
  });
});
