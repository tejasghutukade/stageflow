import { type ChildProcess, spawn as spawnDefault } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGlobalHome } from "../project/globalHome.js";
import { DEFAULT_PORT } from "./createHttpHost.js";

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
export type ServiceProbeResult = "up" | "unreachable" | "unhealthy";

export function hostBaseUrl(): string {
  return `http://127.0.0.1:${resolveServicePort()}`;
}

export async function probeGlobalServiceDetailed(): Promise<ServiceProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    let res: Response;
    try {
      res = await fetch(`${hostBaseUrl()}/api/health`, { signal: ac.signal });
    } catch {
      return "unreachable";
    }
    if (res.status !== 200) return "unhealthy";
    try {
      JSON.parse(await res.text());
    } catch {
      return "unhealthy";
    }
    return "up";
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultProbeHost(): Promise<HostProbeResult> {
  return (await probeGlobalServiceDetailed()) === "up" ? "up" : "down";
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS =
  Number(process.env.STAGEFLOW_AUTOSTART_TIMEOUT_MS) || 10_000;

export const STAGEFLOW_NO_AUTOSTART = "STAGEFLOW_NO_AUTOSTART";

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
        | "autostart_disabled";
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
  if (initial === "unhealthy") {
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

  const cliEntry = options.cliEntry ?? process.argv[1] ?? "";
  const globalHome = ensureGlobalHome();
  const logPath = path.join(globalHome, "service.log");

  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
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
