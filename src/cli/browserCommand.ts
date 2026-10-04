import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { localAuditLogPath, type AuditSink } from "../browser/auditSink.js";
import type {
  BrowserEnv,
  BrowserHost,
  BrowserRunner,
} from "../browser/browserHost.js";
import { closeBrowserSession, defaultBrowserRunner } from "../browser/browserTeardown.js";
import { defaultDisplayProbe, noScreenError, type DisplayProbe } from "../browser/humanLogin.js";
import { createLocalBrowserHost } from "../browser/localBrowserHost.js";
import { createLocalProfileLock } from "../browser/localProfileLock.js";
import { createLocalProfileStore } from "../browser/localProfileStore.js";
import { matchLoginState, runLoginCheck } from "../browser/loginCheck.js";
import type { ProfileLock, ProfileLockOwner, RunLiveness } from "../browser/profileLock.js";
// TODO(multi-tenant): every `sf browser` command below uses the fixed local scope.
// In a hosted service the scope must come from the signed-in user. Search for LOCAL_BROWSER_SCOPE in this file.
import {
  InvalidProfileKeyError,
  LOCAL_BROWSER_SCOPE,
  type ProfileHandle,
  type ProfileStore,
  validateProfileName,
} from "../browser/profileStore.js";
import { cliRunLive, createRunLiveness } from "../browser/runLiveness.js";
import { loadHostConfig } from "../config/hostConfig.js";
import { BlockedSiteError, hostOf, isBlockedHost } from "../browser/sitePolicy.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStore, storeNeedsHostMigration } from "../runstore/createStore.js";
import { resolveStoreRoot } from "../runstore/paths.js";
import type { StageBrowserConfig } from "../types/stage.js";

export const BROWSER_USAGE = `Usage:
  sf browser profiles [--json]
  sf browser status <name> [--json]
  sf browser check <name> --url <url> --logged-in <glob> [--logged-out <glob>]... [--headless] [--json]
  sf browser login <name> --url <login-url> --logged-in <glob> [--timeout-sec <n>] [--json]
  sf browser clear <name> [--yes] [--json]

Manage saved browser logins (profiles) on this computer. Output never shows profile paths or cookie values.
Exit codes: 0 ok / logged in; 1 error; 2 profile in use by a live run; 3 logged out; 4 unknown; 5 login not completed (timeout or window closed); 130 interrupted.`;

export const BROWSER_EXIT = {
  ok: 0,
  error: 1,
  busy: 2,
  loggedOut: 3,
  unknown: 4,
  notCompleted: 5,
  interrupted: 130,
} as const;

const DEFAULT_LOGIN_TIMEOUT_SEC = 300;
const LOGIN_POLL_MS = 1000;
const LOGIN_CLOSED_AFTER_FAILED_READS = 3;
const STAGE_ID = "browser-cli";

export type BrowserCommandDeps = {
  log: (line: string) => void;
  error: (line: string) => void;
  store: ProfileStore;
  host: BrowserHost;
  locks: ProfileLock;
  runner: BrowserRunner;
  audit?: AuditSink;
  /** Host-blocked sites; defaults to `browser.blocked_sites` from Host config. */
  blockedSites?: readonly string[];
  display: DisplayProbe;
  /** Liveness of the run holding a profile lock. */
  isRunLive: RunLiveness;
  /** True when a daemon session for this env is open. */
  sessionOpen: (env: BrowserEnv) => boolean;
  /** profile name -> ISO time of last recorded use (from the audit log). */
  auditLastUsed: () => Promise<Record<string, string>>;
  confirm: (question: string) => Promise<boolean>;
  interactive: boolean;
  signal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  closeWaitMs?: number;
  loginCheck?: { waitMs?: number; settleMs?: number };
  loginPollMs?: number;
};

class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exit: number,
  ) {
    super(message);
  }
}

function defaultIsRunLive(): RunLiveness {
  let inner: RunLiveness | undefined;
  return async (runId) => {
    const cli = cliRunLive(runId);
    if (cli !== undefined) return cli;
    try {
      const home = globalStageflowHome();
      if (!existsSync(path.join(resolveStoreRoot(home), "state.db"))) return false;
      if (storeNeedsHostMigration(home)) return true;
      inner ??= createRunLiveness(createRunStore({ rootDir: home, openerMode: "assert" }));
      return await inner(runId);
    } catch {
      return true;
    }
  };
}

function defaultSessionOpen(env: BrowserEnv): boolean {
  const dir = env.AGENT_BROWSER_SOCKET_DIR;
  const session = env.AGENT_BROWSER_SESSION;
  if (!dir || !session) return false;
  if (existsSync(path.join(dir, `${session}.sock`))) return true;
  try {
    const pid = Number.parseInt(
      readFileSync(path.join(dir, `${session}.pid`), "utf8").trim(),
      10,
    );
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultAuditLastUsed(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(localAuditLogPath(), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as { at?: string; event?: string; scope?: string; profile?: string };
      if (
        rec.event === "profile_used" &&
        rec.scope === LOCAL_BROWSER_SCOPE &&
        typeof rec.profile === "string" &&
        typeof rec.at === "string" &&
        (out[rec.profile] === undefined || rec.at > out[rec.profile]!)
      ) {
        out[rec.profile] = rec.at;
      }
    } catch {
      // skip bad line
    }
  }
  return out;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function defaultDeps(): BrowserCommandDeps {
  const isRunLive = defaultIsRunLive();
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    store: createLocalProfileStore(),
    host: createLocalBrowserHost(),
    locks: createLocalProfileLock({ isRunLive }),
    runner: defaultBrowserRunner,
    display: () => defaultDisplayProbe(),
    isRunLive,
    sessionOpen: defaultSessionOpen,
    auditLastUsed: defaultAuditLastUsed,
    confirm: defaultConfirm,
    interactive: Boolean(process.stdin.isTTY),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

type Parsed = {
  help: boolean;
  sub?: string;
  name?: string;
  json: boolean;
  url?: string;
  loggedIn?: string;
  loggedOut: string[];
  headless: boolean;
  yes: boolean;
  timeoutSec?: number;
};

function parse(args: string[]): Parsed {
  const out: Parsed = { help: false, json: false, loggedOut: [], headless: false, yes: false };
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    out.help = true;
    return out;
  }
  out.sub = args[0];
  if (!["profiles", "status", "check", "login", "clear"].includes(out.sub)) {
    throw new Error(`Unknown browser subcommand: ${out.sub}`);
  }
  const value = (i: number, flag: string): string => {
    const v = args[i];
    if (v === undefined || v.length === 0 || v.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return v;
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--headless") out.headless = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--url") out.url = value(++i, a);
    else if (a === "--logged-in") out.loggedIn = value(++i, a);
    else if (a === "--logged-out") out.loggedOut.push(value(++i, a));
    else if (a === "--timeout-sec") {
      const n = Number(value(++i, a));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --timeout-sec: ${args[i]}`);
      out.timeoutSec = n;
    } else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else if (out.name === undefined && out.sub !== "profiles") out.name = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return out;
}

function requireName(p: Parsed): string {
  if (p.name === undefined) throw new Error(`sf browser ${p.sub} needs a profile name`);
  return validateProfileName(p.name);
}

function newOwner(): ProfileLockOwner {
  return { runId: `cli-${process.pid}-${randomBytes(4).toString("hex")}`, stageId: STAGE_ID };
}

async function withProfile(
  deps: BrowserCommandDeps,
  name: string,
  fn: (handle: ProfileHandle) => Promise<number>,
  options: { create: boolean },
): Promise<number> {
  const names = await deps.store.list(LOCAL_BROWSER_SCOPE);
  if (!options.create && !names.includes(name)) {
    throw new CliError(`Profile "${name}" does not exist. Create it with sf browser login.`, "not_found", BROWSER_EXIT.error);
  }
  const owner = newOwner();
  const got = await deps.locks.acquire({ scope: LOCAL_BROWSER_SCOPE, name }, owner);
  if (got.status === "queued") {
    throw new CliError(
      `Profile "${name}" is in use by run ${got.holder.runId}${got.holder.stageId !== undefined ? ` stage ${got.holder.stageId}` : ""}. Try again when it finishes.`,
      "profile_busy",
      BROWSER_EXIT.busy,
    );
  }
  try {
    const handle = await deps.store.open({ scope: LOCAL_BROWSER_SCOPE, name });
    return await fn(handle);
  } finally {
    await got.release().catch(() => undefined);
  }
}

async function envFor(
  deps: BrowserCommandDeps,
  handle: ProfileHandle,
  browser: StageBrowserConfig,
  humanLogin = false,
): Promise<BrowserEnv> {
  return deps.host.profileBrowserEnv({
    runId: newOwner().runId,
    browser,
    profile: handle,
    ...(humanLogin ? { humanLogin: true } : {}),
  });
}

function emit(deps: BrowserCommandDeps, json: boolean, doc: unknown, text: string[]): void {
  if (json) deps.log(JSON.stringify(doc, null, 2));
  else for (const line of text) deps.log(line);
}

function closeOpts(deps: BrowserCommandDeps) {
  return {
    runner: deps.runner,
    ...(deps.closeWaitMs !== undefined ? { closeWaitMs: deps.closeWaitMs } : {}),
  };
}

async function profilesCmd(deps: BrowserCommandDeps, p: Parsed): Promise<number> {
  const names = await deps.store.list(LOCAL_BROWSER_SCOPE);
  const audited = await deps.auditLastUsed().catch(() => ({}) as Record<string, string>);
  const profiles: { name: string; last_used: string | null }[] = [];
  for (const name of names) {
    let last = audited[name];
    try {
      const handle = await deps.store.open({ scope: LOCAL_BROWSER_SCOPE, name });
      const iso = (await stat(handle.profileDir)).mtime.toISOString();
      if (last === undefined || iso > last) last = iso;
    } catch {
      // store without a real folder
    }
    profiles.push({ name, last_used: last ?? null });
  }
  emit(deps, p.json, { profiles }, profiles.length === 0
    ? []
    : profiles.map((x) => `${x.name}\t${x.last_used ?? "never"}`));
  return BROWSER_EXIT.ok;
}

async function statusCmd(deps: BrowserCommandDeps, p: Parsed): Promise<number> {
  const name = requireName(p);
  const exists = (await deps.store.list(LOCAL_BROWSER_SCOPE)).includes(name);
  let lock: { run_id: string; stage_id: string | null; live: boolean } | null = null;
  const holder = await deps.locks.holder({ scope: LOCAL_BROWSER_SCOPE, name });
  if (holder !== undefined) {
    lock = {
      run_id: holder.runId,
      stage_id: holder.stageId ?? null,
      live: await deps.isRunLive(holder.runId).catch(() => true),
    };
  }
  let sessionOpen = false;
  if (exists) {
    const handle = await deps.store.open({ scope: LOCAL_BROWSER_SCOPE, name });
    sessionOpen = deps.sessionOpen(await envFor(deps, handle, { profile: name }));
  }
  const doc = { name, exists, locked: lock !== null, lock, session_open: sessionOpen };
  emit(deps, p.json, doc, [
    `profile: ${name}`,
    `exists: ${exists ? "yes" : "no"}`,
    lock === null
      ? "lock: free"
      : `lock: held by run ${lock.run_id}${lock.stage_id !== null ? ` stage ${lock.stage_id}` : ""}${lock.live ? "" : " (stale)"}`,
    `browser session: ${sessionOpen ? "open" : "closed"}`,
  ]);
  return BROWSER_EXIT.ok;
}

function assertUrlAllowed(deps: BrowserCommandDeps, url: string): void {
  const host = hostOf(url);
  if (host === undefined) return;
  const blocked = deps.blockedSites ?? loadHostConfig().browserBlockedSites;
  if (isBlockedHost(host, blocked) !== undefined) {
    throw new BlockedSiteError(
      `sf browser: --url "${host}" is blocked by Host policy (browser.blocked_sites)`,
    );
  }
}

async function checkCmd(deps: BrowserCommandDeps, p: Parsed): Promise<number> {
  const name = requireName(p);
  if (p.url === undefined || p.loggedIn === undefined) {
    throw new Error("sf browser check needs --url and --logged-in");
  }
  assertUrlAllowed(deps, p.url);
  const check = {
    url: p.url,
    logged_in_url: p.loggedIn,
    ...(p.loggedOut.length > 0 ? { logged_out_url: p.loggedOut } : {}),
  };
  return withProfile(deps, name, async (handle) => {
    const env = await envFor(deps, handle, { profile: name, headed: !p.headless, check });
    try {
      const result = await runLoginCheck(env, check, deps.runner, deps.loginCheck);
      emit(deps, p.json, { logged_in: result.logged_in, url: result.url, state: result.state }, [
        `state: ${result.state}`,
        `logged_in: ${result.logged_in === null ? "unknown" : result.logged_in}`,
        `url: ${result.url}`,
      ]);
      return result.state === "logged_in"
        ? BROWSER_EXIT.ok
        : result.state === "logged_out"
          ? BROWSER_EXIT.loggedOut
          : BROWSER_EXIT.unknown;
    } finally {
      await closeBrowserSession(env, closeOpts(deps)).catch(() => undefined);
    }
  }, { create: false });
}

async function loginCmd(deps: BrowserCommandDeps, p: Parsed): Promise<number> {
  const name = requireName(p);
  if (p.url === undefined || p.loggedIn === undefined) {
    throw new Error("sf browser login needs --url and --logged-in");
  }
  assertUrlAllowed(deps, p.url);
  const screen = deps.display();
  if (!screen.hasDisplay) throw noScreenError(screen.docker);
  let signal = deps.signal;
  if (signal === undefined) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    signal = controller.signal;
  }
  const timeoutMs = (p.timeoutSec ?? DEFAULT_LOGIN_TIMEOUT_SEC) * 1000;
  const pollMs = deps.loginPollMs ?? LOGIN_POLL_MS;

  return withProfile(deps, name, async (handle) => {
    const env = await envFor(deps, handle, { profile: name, headed: true }, true);
    let status: "logged_in" | "timeout" | "closed" | "interrupted" = "timeout";
    let url = "";
    try {
      const opened = await deps.runner(["open", p.url!], env);
      if (opened.code !== 0) throw new CliError(`Could not open ${p.url}`, "open_failed", BROWSER_EXIT.error);
      if (!p.json) deps.error("Log in in the browser window. Waiting for the login to finish (Ctrl-C to stop).");
      const deadline = Date.now() + timeoutMs;
      let failedReads = 0;
      for (;;) {
        if (signal.aborted) {
          status = "interrupted";
          break;
        }
        const got = await deps.runner(["get", "url"], env).catch(() => ({ code: 1 as number | null, stdout: "" }));
        if (got.code === 0) {
          failedReads = 0;
          url = (got.stdout ?? "").trim();
          if (matchLoginState({ finalUrl: url, check: { logged_in_url: p.loggedIn } }).state === "logged_in") {
            status = "logged_in";
            break;
          }
        } else if (++failedReads >= LOGIN_CLOSED_AFTER_FAILED_READS) {
          status = "closed";
          break;
        }
        if (Date.now() >= deadline) break;
        await deps.sleep(pollMs);
      }
    } finally {
      await closeBrowserSession(env, closeOpts(deps)).catch(() => undefined);
    }
    const doc = { logged_in: status === "logged_in", url, state: status };
    emit(deps, p.json, doc, [
      status === "logged_in"
        ? `Logged in. Profile "${name}" is saved.`
        : status === "interrupted"
          ? "Stopped before login finished."
          : status === "closed"
            ? "The browser window was closed before login finished."
            : "Timed out before login finished.",
    ]);
    return status === "logged_in"
      ? BROWSER_EXIT.ok
      : status === "interrupted"
        ? BROWSER_EXIT.interrupted
        : BROWSER_EXIT.notCompleted;
  }, { create: true });
}

async function clearCmd(deps: BrowserCommandDeps, p: Parsed): Promise<number> {
  const name = requireName(p);
  if (!(await deps.store.list(LOCAL_BROWSER_SCOPE)).includes(name)) {
    throw new CliError(`Profile "${name}" does not exist.`, "not_found", BROWSER_EXIT.error);
  }
  if (!p.yes) {
    if (!deps.interactive) {
      throw new CliError(
        `Refusing to delete profile "${name}" without confirmation. Pass --yes.`,
        "confirmation_required",
        BROWSER_EXIT.error,
      );
    }
    if (!(await deps.confirm(`Delete browser profile "${name}" and its saved logins?`))) {
      emit(deps, p.json, { cleared: false, name }, ["Cancelled."]);
      return BROWSER_EXIT.error;
    }
  }
  return withProfile(deps, name, async (handle) => {
    const env = await envFor(deps, handle, { profile: name });
    await closeBrowserSession(env, closeOpts(deps)).catch(() => undefined);
    await deps.store.delete({ scope: LOCAL_BROWSER_SCOPE, name });
    emit(deps, p.json, { cleared: true, name }, [`Cleared profile "${name}".`]);
    return BROWSER_EXIT.ok;
  }, { create: false });
}

export async function runBrowserCommand(
  args: string[],
  deps?: Partial<BrowserCommandDeps>,
): Promise<number> {
  let json = args.includes("--json");
  const io = deps?.log !== undefined && deps?.error !== undefined
    ? { log: deps.log, error: deps.error }
    : { log: (l: string) => console.log(l), error: (l: string) => console.error(l) };
  let parsed: Parsed;
  try {
    parsed = parse(args);
    json = parsed.json;
  } catch (err) {
    io.error((err as Error).message);
    io.error(BROWSER_USAGE);
    return BROWSER_EXIT.error;
  }
  if (parsed.help) {
    io.log(BROWSER_USAGE);
    return BROWSER_EXIT.ok;
  }
  const resolved: BrowserCommandDeps = { ...defaultDeps(), ...deps };
  try {
    switch (parsed.sub) {
      case "profiles":
        return await profilesCmd(resolved, parsed);
      case "status":
        return await statusCmd(resolved, parsed);
      case "check":
        return await checkCmd(resolved, parsed);
      case "login":
        return await loginCmd(resolved, parsed);
      default:
        return await clearCmd(resolved, parsed);
    }
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    const code = cli?.code ?? (err instanceof InvalidProfileKeyError || err instanceof BlockedSiteError
        ? err.code
        : "error");
    const message = (err as Error).message;
    if (json) resolved.log(JSON.stringify({ error: message, code }, null, 2));
    else resolved.error(message);
    return cli?.exit ?? BROWSER_EXIT.error;
  }
}
