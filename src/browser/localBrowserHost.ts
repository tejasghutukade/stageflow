import { accessSync, constants } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  type ProfileBrowserRequest,
  type ProfileBrowserResult,
  shortHash,
} from "./browserHost.js";
import type { BrowserHostCapabilityRecord, DisplayCapability } from "./hostCapabilities.js";
import type { ProfileHandle } from "./profileStore.js";

const MAX_SOCKET_PATH_BYTES = 103;
const MAX_SESSION_NAME_LENGTH = 48;
export const DENY_PERMISSION_PROMPTS_ARG = "--deny-permission-prompts";
const HOST_LAUNCH_ARGS: readonly string[] = [DENY_PERMISSION_PROMPTS_ARG];
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;

export type LocalBrowserHostOptions = {
  platform?: NodeJS.Platform;
  /** Read only for display detection; never for AGENT_BROWSER_* settings. */
  hostEnv?: Record<string, string | undefined>;
  socketRoot?: string;
  emptyConfigPath?: string;
  /** `relay` only when the process also serves the live view routes; default `none`. */
  liveView?: "relay" | "none";
  /** Whether an Xvfb binary is installed; default searches `PATH` for an executable `Xvfb`. */
  xvfbProbe?: () => boolean;
  /** Host config `browser.launch_args`; applied only to sessions that launch Chrome, after the Host's own switches. */
  launchArgs?: readonly string[];
  /** Host config `browser.executable_path`; applied only to sessions that launch Chrome. */
  executablePath?: string;
};

export function defaultXvfbProbe(
  platform: NodeJS.Platform = process.platform,
  hostEnv: Record<string, string | undefined> = process.env,
): boolean {
  const dirs = (hostEnv.PATH ?? "").split(platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (dir === "") continue;
    try {
      accessSync(path.join(dir, "Xvfb"), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function defaultSocketRoot(platform: NodeJS.Platform): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  const base = platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(base, `sfb-${uid}`);
}

function sessionNameForProfile(scope: string, name: string): string {
  const plain = `sf-${name}`;
  if (plain.length <= MAX_SESSION_NAME_LENGTH) return plain;
  return `${plain.slice(0, MAX_SESSION_NAME_LENGTH - 7)}-${shortHash(`${scope}/${name}`, 6)}`;
}

function sessionNameForProfileStage(
  profile: ProfileHandle,
  runId: string,
  stageId: string,
): string {
  const suffix = shortHash(`${runId}/${stageId}`, 6);
  const plain = `sf-${profile.key.name}`;
  const room = MAX_SESSION_NAME_LENGTH - suffix.length - 1;
  return `${plain.slice(0, room)}-${suffix}`;
}

const OPEN_ANCHOR_TIMEOUT_MS = 60_000;

function displayKind(
  platform: NodeJS.Platform,
  hostEnv: Record<string, string | undefined>,
  xvfbProbe: () => boolean,
): DisplayCapability {
  if (platform !== "linux") return "local_window";
  if (hostEnv.DISPLAY || hostEnv.WAYLAND_DISPLAY) return "local_window";
  return xvfbProbe() ? "virtual_display" : "headless_only";
}

export function createLocalBrowserHost(
  options: LocalBrowserHostOptions = {},
): BrowserHost {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;
  const display = displayKind(
    platform,
    hostEnv,
    options.xvfbProbe ?? (() => defaultXvfbProbe(platform, hostEnv)),
  );
  const launchArgs = [
    ...HOST_LAUNCH_ARGS,
    ...(options.launchArgs ?? []).filter((arg) => !HOST_LAUNCH_ARGS.includes(arg)),
  ];
  const executablePath = options.executablePath;

  async function build(input: {
    identity: string;
    session: string;
    headed: boolean;
    launches: boolean;
    set: (env: BrowserEnv) => void;
  }): Promise<BrowserEnv> {
    const socketRoot = options.socketRoot ?? defaultSocketRoot(platform);
    const socketDir = path.join(socketRoot, shortHash(input.identity, 8));
    const socketPathBytes = Buffer.byteLength(
      path.join(socketDir, `${input.session}.sock`),
    );
    if (socketPathBytes > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `browser socket path is ${socketPathBytes} bytes (limit ${MAX_SOCKET_PATH_BYTES})`,
      );
    }
    await mkdir(socketDir, { recursive: true, mode: 0o700 });

    const emptyConfigPath =
      options.emptyConfigPath ??
      path.join(globalStageflowHome(), "browser", "agent-browser.empty.json");
    await mkdir(path.dirname(emptyConfigPath), { recursive: true, mode: 0o700 });
    await writeFile(emptyConfigPath, "{}\n", { mode: 0o600 });

    const env: BrowserEnv = {
      AGENT_BROWSER_SESSION: input.session,
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      AGENT_BROWSER_HEADED: input.headed ? "1" : "0",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AGENT_BROWSER_CONFIG: emptyConfigPath,
    };
    input.set(env);
    if (input.launches) {
      env.AGENT_BROWSER_ARGS = launchArgs.join(",");
      if (executablePath !== undefined) env.AGENT_BROWSER_EXECUTABLE_PATH = executablePath;
    }
    if (input.headed && platform === "linux" && display === "local_window") {
      for (const name of DISPLAY_VARS) {
        const value = hostEnv[name];
        if (value) env[name] = value;
      }
    }
    return env;
  }

  function headedFor(
    request: Pick<BrowserStageRequest, "browser" | "humanLogin">,
  ): boolean {
    return (
      request.humanLogin === true ||
      ((request.browser.headed ?? true) && display !== "headless_only")
    );
  }

  async function profileBrowserEnv(
    request: Omit<BrowserStageRequest, "stageId" | "cdpAddress"> & {
      profile: ProfileHandle;
    },
  ): Promise<BrowserEnv> {
    const { profile } = request;
    const profileDir = profile.profileDir;
    if (profileDir === undefined) {
      throw new Error(`profile "${profile.key.name}" has no folder; the local browser host needs one`);
    }
    return build({
      identity: `profile:${profile.key.scope}/${profile.key.name}:${profileDir}`,
      session: sessionNameForProfile(profile.key.scope, profile.key.name),
      headed: headedFor(request),
      launches: true,
      set: (env) => {
        env.AGENT_BROWSER_PROFILE = profileDir;
      },
    });
  }

  async function readCdpAddress(
    request: ProfileBrowserRequest,
    env: BrowserEnv,
  ): Promise<string> {
    const got = await request.runner(["get", "cdp-url"], env, {
      timeoutMs: OPEN_ANCHOR_TIMEOUT_MS,
    });
    const address = (got.stdout ?? "").trim();
    if (got.code !== 0 || !/^wss?:\/\//.test(address)) {
      throw new Error("could not read the shared browser address (agent-browser get cdp-url)");
    }
    return address;
  }

  const capabilities: BrowserHostCapabilityRecord = {
    display,
    liveView: options.liveView ?? "none",
    attach: "host_launched",
    profilePersistence: "host_volume",
    gracefulCloseRequired: true,
  };

  return {
    capabilities,

    async ensureProfileBrowser(
      request: ProfileBrowserRequest,
    ): Promise<ProfileBrowserResult> {
      const wantHeaded = headedFor(request);
      let previous = request.previous;
      if (
        previous !== undefined &&
        wantHeaded &&
        previous.anchorEnv.AGENT_BROWSER_HEADED !== "1"
      ) {
        await request.runner(["close"], previous.anchorEnv).catch(() => undefined);
        previous = undefined;
      }
      if (previous !== undefined) {
        // Any command relaunches a dead anchor, so reading the address is the liveness probe.
        const cdpAddress = await readCdpAddress(request, previous.anchorEnv);
        return {
          cdpAddress,
          anchorEnv: previous.anchorEnv,
          restarted: cdpAddress !== previous.cdpAddress,
        };
      }
      const anchorEnv = await profileBrowserEnv(request);
      const opened = await request.runner(["open", "about:blank"], anchorEnv, {
        timeoutMs: OPEN_ANCHOR_TIMEOUT_MS,
      });
      if (opened.code !== 0) throw new Error("could not start the shared browser");
      const cdpAddress = await readCdpAddress(request, anchorEnv);
      return {
        cdpAddress,
        anchorEnv,
        restarted: request.previous !== undefined,
      };
    },

    profileBrowserEnv,

    async stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      const { browser, profile } = request;
      if (profile !== undefined) {
        if (request.cdpAddress === undefined) {
          throw new Error("a stage with a browser profile needs the shared browser address");
        }
        const cdp = request.cdpAddress;
        return build({
          identity: `stage:${request.runId}/${request.stageId}`,
          session: sessionNameForProfileStage(profile, request.runId, request.stageId),
          headed: headedFor(request),
          launches: false,
          set: (env) => {
            env.AGENT_BROWSER_CDP = cdp;
            env.AGENT_BROWSER_PIN_TAB = "1";
          },
        });
      }
      const identity = `stage:${request.runId}/${request.stageId}`;
      return build({
        identity,
        session: `sf-t-${shortHash(identity, 12)}`,
        headed: headedFor(request),
        launches: true,
        set: (env) => {
          if (browser.allow_domains && browser.allow_domains.length > 0) {
            env.AGENT_BROWSER_ALLOWED_DOMAINS = browser.allow_domains.join(",");
          }
        },
      });
    },
  };
}
