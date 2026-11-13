import { type ChildProcess, spawn as spawnDefault } from "node:child_process";
import { chmodSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStageflowHomeId } from "../diagnostics/checks.js";
import { ensureGlobalHome } from "../project/globalHome.js";
import {
  assertBindAllowed,
  BindRefusedError,
  hasDriveToken,
  loadControlTokens,
} from "./controlToken.js";
import { DEFAULT_PORT } from "./createHttpHost.js";
import { resolveListenHost } from "./listenHost.js";

/**
 * The well-known port the global service listens on. Overridable via
 * STAGEFLOW_SERVICE_PORT — real usage never sets this (there's exactly one
 * global service by design), but tests use it to point a spawned `sf run`
 * subprocess at an isolated, already-running test server instead of the
 * real machine's global service.
 */
function resolveServicePort(): number {
  const raw = process.env.STAGEFLOW_SERVICE_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

/**
 * The published `sf` binary is compiled JS (`dist/cli.js`), directly
 * runnable as `node <entry> mcp`. In dev/test, `cliEntry` is instead raw
 * TypeScript source (`src/cli.ts`), which plain node can't execute — route
 * through the same tsx loader `npm run dev` already uses for that case.
 */
function resolveSpawnArgs(cliEntry: string): string[] {
  const portArgs = ["--port", String(resolveServicePort())];
  if (!/\.(?:m|c)?ts$/.test(cliEntry)) {
    return [cliEntry, "mcp", ...portArgs];
  }
  try {
    const tsxCliUrl = import.meta.resolve("tsx/cli");
    return [fileURLToPath(tsxCliUrl), cliEntry, "mcp", ...portArgs];
  } catch {
    return [cliEntry, "mcp", ...portArgs];
  }
}

/** Coarse up/down probe result, used by CLI code that only needs "is it safe to talk to the host." */
export type HostProbeResult = "up" | "down";

/**
 * Finer-grained probe result used to auto-start: "unreachable" (nothing
 * listening, safe to spawn) is distinct from "unhealthy" (something is
 * listening on the port but didn't answer with valid health JSON, so it's
 * almost certainly not our service and spawning would just collide).
 */
export type ServiceProbeResult =
  | "up"
  | "starting"
  | "unreachable"
  | "unhealthy"
  | "foreign"
  | "other_home"
  | "old_stageflow";

/** An older Stageflow Host (before 0.57) still holds the port, usually the service left running across an upgrade. */
export function oldHostRunningMessage(port: number | string): string {
  return `An older Stageflow Host is running on port ${port}. Stop it (end its "sf mcp" or "sf ui" process, or restart the container), then run this again.`;
}

export function otherHostHomeMessage(port: number | string): string {
  return `Another Stageflow Host with a different data directory is on port ${port}. Stop it or use --port.`;
}

export function hostBaseUrl(): string {
  return `http://127.0.0.1:${resolveServicePort()}`;
}

/**
 * Whether a Host's reported home id is another data directory. `expected` may be a function, read after the Host
 * answered (so a Host that just created its id is seen). An expected id of undefined means no Host ever used this
 * directory, so any reported id is someone else's.
 */
function homeMismatch(
  expected: string | (() => string | undefined) | undefined,
  reported: unknown,
): boolean {
  if (expected === undefined) return false;
  const mine = typeof expected === "function" ? expected() : expected;
  if (typeof reported !== "string") return false;
  return mine === undefined || reported !== mine;
}

export async function probeStageflowHost(
  baseUrl: string,
  options?: { expectedHomeId?: string | (() => string | undefined) },
): Promise<ServiceProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/livez`, { signal: ac.signal });
    } catch {
      return "unreachable";
    }
    if (res.status !== 200) return "unhealthy";
    let body: { ok?: unknown; status?: unknown; service?: unknown; home_id?: unknown };
    try {
      body = JSON.parse(await res.text()) as typeof body;
    } catch {
      return "unhealthy";
    }
    if (body === null || typeof body !== "object") return "foreign";
    if (body.service === "stageflow" && body.status === "starting") {
      // A booting Host names its data directory too; one from another directory is not ours.
      if (homeMismatch(options?.expectedHomeId, body.home_id)) return "other_home";
      return "starting";
    }
    if (body.service !== "stageflow") {
      // Hosts before 0.57 answer {"ok":true,"status":"live"} with no service field.
      return body.service === undefined && body.ok === true && body.status === "live"
        ? "old_stageflow"
        : "foreign";
    }
    if (homeMismatch(options?.expectedHomeId, body.home_id)) return "other_home";
    return "up";
  } finally {
    clearTimeout(timer);
  }
}

export async function probeGlobalServiceDetailed(): Promise<ServiceProbeResult> {
  return probeStageflowHost(hostBaseUrl(), {
    expectedHomeId: () => readStageflowHomeId(),
  });
}

export async function defaultProbeHost(): Promise<HostProbeResult> {
  return (await probeGlobalServiceDetailed()) === "up" ? "up" : "down";
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS =
  Number(process.env.STAGEFLOW_AUTOSTART_TIMEOUT_MS) || 10_000;

export const STAGEFLOW_NO_AUTOSTART = "STAGEFLOW_NO_AUTOSTART";

/** Set on the process `ensureGlobalService` spawns so it does not print the control token. */
export const SF_SERVICE_CHILD = "SF_SERVICE_CHILD";

/** Truthy when set and not empty / `0` / `false` (case-insensitive). */
export function isNoAutostartEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[STAGEFLOW_NO_AUTOSTART];
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export type EnsureGlobalServiceResult =
  | { ok: true; alreadyRunning: boolean }
  | {
      ok: false;
      reason:
        | "port_occupied"
        | "spawn_failed"
        | "timed_out"
        | "autostart_disabled"
        | "bind_refused"
        | "old_host_running";
      message: string;
    };

export interface EnsureGlobalServiceOptions {
  /** Path to the CLI entry script to spawn `<entry> mcp` against. Defaults to the running process's own entry (process.argv[1]). */
  cliEntry?: string;
  probeHost?: () => Promise<ServiceProbeResult>;
  spawnFn?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawnDefault>[2],
  ) => ChildProcess;
  pollIntervalMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Health-probe-then-spawn: makes sure a global Stageflow service is
 * reachable at the well-known port, starting one headlessly (`<cliEntry>
 * mcp`, detached) if nothing answers yet. No-ops if one is already up.
 */
export async function ensureGlobalService(
  options: EnsureGlobalServiceOptions = {},
): Promise<EnsureGlobalServiceResult> {
  const probeHost = options.probeHost ?? probeGlobalServiceDetailed;
  const spawnFn = options.spawnFn ?? spawnDefault;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;

  const initial = await probeHost();
  if (initial === "up") {
    return { ok: true, alreadyRunning: true };
  }
  if (initial === "starting") {
    let last: ServiceProbeResult = "starting";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const next = await probeHost();
      if (next === "up") return { ok: true, alreadyRunning: true };
      if (next !== "starting") {
        last = next;
        break;
      }
    }
    if (last === "other_home") {
      return { ok: false, reason: "port_occupied", message: otherHostHomeMessage(resolveServicePort()) };
    }
    if (last === "old_stageflow") {
      return { ok: false, reason: "old_host_running", message: oldHostRunningMessage(resolveServicePort()) };
    }
    if (last === "unreachable") {
      return {
        ok: false,
        reason: "timed_out",
        message: `The starting Stageflow Host on port ${resolveServicePort()} stopped before it became ready. Check its log, then try again.`,
      };
    }
    return {
      ok: false,
      reason: "timed_out",
      message: `Timed out after ${timeoutMs}ms waiting for the starting Stageflow Host to become ready.`,
    };
  }
  if (initial === "old_stageflow") {
    return {
      ok: false,
      reason: "old_host_running",
      message: oldHostRunningMessage(resolveServicePort()),
    };
  }
  if (initial === "other_home") {
    return {
      ok: false,
      reason: "port_occupied",
      message: otherHostHomeMessage(resolveServicePort()),
    };
  }
  if (initial === "unhealthy" || initial === "foreign") {
    return {
      ok: false,
      reason: "port_occupied",
      message: `Port ${resolveServicePort()} is already in use by a process that isn't the Stageflow service (its health check didn't return valid health JSON). Free the port and try again.`,
    };
  }

  if (isNoAutostartEnabled(env)) {
    const url = hostBaseUrl();
    return {
      ok: false,
      reason: "autostart_disabled",
      message: `No Stageflow Host is answering at ${url}. Autostart is disabled (STAGEFLOW_NO_AUTOSTART). Start the Host with \`sf mcp\`, or in Docker check that the container's entrypoint is running.`,
    };
  }

  try {
    const bind = resolveListenHost({ env });
    const tokens = loadControlTokens(env);
    // The spawned `sf mcp` writes a token before it binds. Do not refuse here,
    // and do not set STAGEFLOW_CONTROL_TOKEN_FILE on this parent process.
    const childGeneratesToken =
      !hasDriveToken(tokens) && env.STAGEFLOW_ALLOW_UNAUTHENTICATED_BIND !== "1";
    if (!childGeneratesToken) {
      assertBindAllowed(bind, tokens, env);
    }
  } catch (err) {
    if (err instanceof BindRefusedError) {
      return {
        ok: false,
        reason: "bind_refused",
        message: err.message,
      };
    }
    throw err;
  }

  const cliEntry = options.cliEntry ?? process.argv[1] ?? "";
  const globalHome = ensureGlobalHome();
  const logPath = path.join(globalHome, "service.log");

  let logFd: number;
  try {
    logFd = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
  } catch (err) {
    return {
      ok: false,
      reason: "spawn_failed",
      message: `Failed to open service log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const spawnArgs = resolveSpawnArgs(cliEntry);
    const child = spawnFn(process.execPath, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, [SF_SERVICE_CHILD]: "1" },
    });
    child.unref();
  } catch (err) {
    return {
      ok: false,
      reason: "spawn_failed",
      message: `Failed to spawn the global Stageflow service: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    if ((await probeHost()) === "up") {
      return { ok: true, alreadyRunning: false };
    }
  }

  return {
    ok: false,
    reason: "timed_out",
    message: `Timed out after ${timeoutMs}ms waiting for the global Stageflow service to become healthy. Check the log at ${logPath}.`,
  };
}
