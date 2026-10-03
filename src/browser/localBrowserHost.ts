import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  type BrowserEnv,
  type BrowserHost,
  type BrowserStageRequest,
  shortHash,
} from "./browserHost.js";

const MAX_SOCKET_PATH_BYTES = 103;
const MAX_SESSION_NAME_LENGTH = 48;
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;

export type LocalBrowserHostOptions = {
  platform?: NodeJS.Platform;
  /** Read only for display detection; never for AGENT_BROWSER_* settings. */
  hostEnv?: Record<string, string | undefined>;
  socketRoot?: string;
  emptyConfigPath?: string;
};

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

function hasDisplay(
  platform: NodeJS.Platform,
  hostEnv: Record<string, string | undefined>,
): boolean {
  if (platform !== "linux") return true;
  return Boolean(hostEnv.DISPLAY || hostEnv.WAYLAND_DISPLAY);
}

export function createLocalBrowserHost(
  options: LocalBrowserHostOptions = {},
): BrowserHost {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;

  return {
    async stageEnv(request: BrowserStageRequest): Promise<BrowserEnv> {
      const { browser, profile } = request;
      const headed =
        request.humanLogin === true ||
        ((browser.headed ?? true) && hasDisplay(platform, hostEnv));

      const identity = profile
        ? `profile:${profile.key.scope}/${profile.key.name}:${profile.profileDir}`
        : `stage:${request.runId}/${request.stageId}`;
      const session = profile
        ? sessionNameForProfile(profile.key.scope, profile.key.name)
        : `sf-t-${shortHash(identity, 12)}`;

      const socketRoot = options.socketRoot ?? defaultSocketRoot(platform);
      const socketDir = path.join(socketRoot, shortHash(identity, 8));
      const socketPathBytes = Buffer.byteLength(
        path.join(socketDir, `${session}.sock`),
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
      await mkdir(path.dirname(emptyConfigPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(emptyConfigPath, "{}\n", { mode: 0o600 });

      const env: BrowserEnv = {
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_SOCKET_DIR: socketDir,
        AGENT_BROWSER_HEADED: headed ? "1" : "0",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
        AGENT_BROWSER_CONFIG: emptyConfigPath,
      };
      if (profile) {
        env.AGENT_BROWSER_PROFILE = profile.profileDir;
      } else if (browser.allow_domains && browser.allow_domains.length > 0) {
        env.AGENT_BROWSER_ALLOWED_DOMAINS = browser.allow_domains.join(",");
      }
      if (headed && platform === "linux") {
        for (const name of DISPLAY_VARS) {
          const value = hostEnv[name];
          if (value) env[name] = value;
        }
      }
      return env;
    },
  };
}
