import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stageDir } from "../runstore/paths.js";
import type { StageBrowserConfig } from "../types/stage.js";
import type { BrowserEnv, BrowserRunner } from "./browserHost.js";
import { defaultBrowserRunner } from "./browserTeardown.js";

export const BROWSER_LOGIN_CHECK_FILENAME = "browser-login-check.json";

export type LoginCheckConfig = NonNullable<StageBrowserConfig["check"]>;
export type LoginState = "logged_in" | "logged_out" | "unknown";

export type LoginCheckMatch = {
  state: LoginState;
  /** `null` when the patterns cannot decide. */
  logged_in: boolean | null;
};

export type LoginCheckResult = LoginCheckMatch & {
  url: string;
  attempt: number;
  check_url: string;
};

const DEFAULT_WAIT_MS = 15_000;
const WAIT_TIMEOUT_MARGIN_MS = 15_000;
export const OPEN_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 300;
const MAX_URL_READS = 4;

/** `*` matches any run of characters (including `/`), `?` one character. Whole-URL match. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of glob.replace(/\*+/g, "*")) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesAny(url: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(url));
}

/** Pure: `logged_out_url` wins over `logged_in_url`; no match is `unknown`. */
export function matchLoginState(input: {
  finalUrl: string;
  check: Pick<LoginCheckConfig, "logged_in_url" | "logged_out_url">;
}): LoginCheckMatch {
  const { finalUrl, check } = input;
  if (matchesAny(finalUrl, asList(check.logged_out_url))) {
    return { state: "logged_out", logged_in: false };
  }
  if (matchesAny(finalUrl, asList(check.logged_in_url))) {
    return { state: "logged_in", logged_in: true };
  }
  return { state: "unknown", logged_in: null };
}

export type LoginCheckOptions = {
  waitMs?: number;
  settleMs?: number;
};

async function readUrl(env: BrowserEnv, runner: BrowserRunner): Promise<string> {
  const got = await runner(["get", "url"], env);
  if (got.code !== 0) {
    throw new Error("login check: could not read the page address");
  }
  return (got.stdout ?? "").trim();
}

/**
 * Opens `check.url` in the stage's own browser session (same persisted env, so
 * no second browser is launched) and matches the settled final address. The
 * session stays open for the stage; its teardown closes it later.
 */
export async function runLoginCheck(
  env: BrowserEnv,
  check: LoginCheckConfig,
  runner: BrowserRunner,
  options: LoginCheckOptions = {},
): Promise<LoginCheckMatch & { url: string }> {
  const opened = await runner(["open", check.url], env, {
    timeoutMs: OPEN_COMMAND_TIMEOUT_MS,
  });
  if (opened.code !== 0) {
    throw new Error(`login check: could not open ${check.url}`);
  }
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  await runner(["wait", "--load", "networkidle", "--timeout", String(waitMs)], env, {
    timeoutMs: waitMs + WAIT_TIMEOUT_MARGIN_MS,
  }).catch(() => undefined);

  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  let url = await readUrl(env, runner);
  for (let i = 1; i < MAX_URL_READS; i++) {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const next = await readUrl(env, runner);
    if (next === url) break;
    url = next;
  }
  if (url === "") {
    throw new Error("login check: the browser reported an empty address");
  }
  return { ...matchLoginState({ finalUrl: url, check }), url };
}

function resultFile(runDir: string, stageId: string): string {
  return path.join(stageDir(runDir, stageId), BROWSER_LOGIN_CHECK_FILENAME);
}

export async function readStageLoginCheck(
  runDir: string,
  stageId: string,
): Promise<LoginCheckResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resultFile(runDir, stageId), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.url === "string") {
      return parsed as LoginCheckResult;
    }
  } catch {
    // not computed yet
  }
  return undefined;
}

/**
 * Computes the Host result once per attempt and persists it in the stage run
 * dir. A resume of the same attempt reuses the stored value, so the result the
 * agent saw is the result the emit is validated against.
 */
export async function ensureStageLoginCheck(input: {
  runDir: string;
  stageId: string;
  attempt: number;
  env: BrowserEnv;
  check: LoginCheckConfig;
  runner?: BrowserRunner;
  options?: LoginCheckOptions;
}): Promise<LoginCheckResult> {
  const existing = await readStageLoginCheck(input.runDir, input.stageId);
  if (
    existing !== undefined &&
    existing.attempt === input.attempt &&
    existing.check_url === input.check.url
  ) {
    return existing;
  }
  const probed = await runLoginCheck(
    input.env,
    input.check,
    input.runner ?? defaultBrowserRunner,
    input.options,
  );
  const result: LoginCheckResult = {
    ...probed,
    attempt: input.attempt,
    check_url: input.check.url,
  };
  const file = resultFile(input.runDir, input.stageId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return result;
}

export type ExpectedLoginResult = Pick<LoginCheckResult, "state" | "logged_in" | "url">;

/** Prompt block that hands the Host result to the agent. */
export function loginCheckPromptBlock(result: ExpectedLoginResult): string {
  const lines = ["## Host login check", ""];
  if (result.state === "unknown") {
    lines.push(
      `The Host opened the check page and its final address is ${JSON.stringify(result.url)}, but the configured patterns cannot decide whether the session is logged in (result: unknown).`,
      "The browser session is already open on that page. Use the browser skill to inspect the page (read-only), decide whether the profile is logged in, and emit payload `{ \"logged_in\": <true|false>, \"url\": <that exact address> }`.",
      "The Host only checks that `logged_in` is a boolean and that `url` equals the address above.",
    );
  } else {
    lines.push(
      `Host login check result: ${JSON.stringify({ logged_in: result.logged_in, url: result.url })}`,
      "Report exactly this in your envelope payload. Do not browse. The Host rejects any other value.",
    );
  }
  return lines.join("\n");
}

/** Emit-time validation of the payload against the Host result; `undefined` when valid. */
export function loginCheckIssue(
  payload: unknown,
  expected: ExpectedLoginResult,
): string | undefined {
  const value =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (typeof value.logged_in !== "boolean") {
    return "login check payload.logged_in must be a boolean";
  }
  if (value.url !== expected.url) {
    return `login check payload.url must equal the Host-observed address ${JSON.stringify(expected.url)}`;
  }
  if (expected.logged_in !== null && value.logged_in !== expected.logged_in) {
    return `login check payload.logged_in must be ${expected.logged_in} (Host result)`;
  }
  return undefined;
}
