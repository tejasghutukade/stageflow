import { accessSync, chmodSync, constants, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SF_STAGE_WORKER } from "../runtime/stageWorkerProtocol.js";

export type StageflowHomeErrorCode = "stageflow_home_not_writable";

export class StageflowHomeError extends Error {
  readonly code: StageflowHomeErrorCode;

  constructor(message: string, code: StageflowHomeErrorCode) {
    super(message);
    this.name = "StageflowHomeError";
    this.code = code;
  }
}

let memoizedHome: string | undefined;
let memoizedCredentialRoot: string | undefined;

export function resetGlobalStageflowHomeForTests(): void {
  memoizedHome = undefined;
  memoizedCredentialRoot = undefined;
}

function resolveStageflowHomeFromEnv(): string {
  const raw = process.env.STAGEFLOW_HOME?.trim();
  if (!raw) {
    return path.join(os.homedir(), ".stageflow");
  }
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  return path.resolve(process.cwd(), raw);
}

/** The Stageflow home as health answers show it: `~/…` inside the user's home folder, else the folder name. Never absolute. */
export function stageflowHomeForDisplay(home: string = globalStageflowHome(), userHome: string = os.homedir()): string {
  const underUser = relativeInside(userHome, home);
  if (underUser !== undefined) return underUser === "" ? "~" : `~/${underUser}`;
  return path.basename(home);
}

/** A Host folder as health answers show it: `~/…`, or under the Stageflow home as `<home as shown>/…`, else the folder name. Never absolute. */
export function hostPathForDisplay(dir: string, home: string = globalStageflowHome(), userHome: string = os.homedir()): string {
  const underUser = relativeInside(userHome, dir);
  if (underUser !== undefined) return underUser === "" ? "~" : `~/${underUser}`;
  const underHome = relativeInside(home, dir);
  if (underHome !== undefined) {
    const shown = stageflowHomeForDisplay(home, userHome);
    return underHome === "" ? shown : `${shown}/${underHome}`;
  }
  return path.basename(dir);
}

function relativeInside(base: string, target: string): string | undefined {
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

/**
 * Remember the data directory without advertising it as `STAGEFLOW_HOME`.
 * Stage workers pass the directory on the command line and set `exportEnv: false`
 * so a stage shell cannot read `$STAGEFLOW_HOME/control-token`.
 */
export function pinStageflowHome(
  dir: string,
  options?: { exportEnv?: boolean },
): void {
  const resolved = path.resolve(dir);
  memoizedHome = resolved;
  if (options?.exportEnv === false) return;
  process.env.STAGEFLOW_HOME = resolved;
}

export function globalStageflowHome(): string {
  if (memoizedHome === undefined) {
    memoizedHome = resolveStageflowHomeFromEnv();
    if (process.env[SF_STAGE_WORKER] !== "1") {
      process.env.STAGEFLOW_HOME = memoizedHome;
    }
  }
  return memoizedHome;
}

/** Create `dir` at mode 0700 when it is missing. An existing directory is left as it is. */
export function createOwnerOnlyDirectory(dir: string): void {
  try {
    lstatSync(dir);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on non-POSIX
  }
}

function resolveCredentialRootFromEnv(): string {
  const raw = process.env.STAGEFLOW_CREDENTIAL_HOME?.trim();
  if (raw) {
    if (path.isAbsolute(raw)) {
      return path.resolve(raw);
    }
    return path.resolve(process.cwd(), raw);
  }
  return path.join(os.homedir(), ".stageflow");
}

export function globalCredentialRoot(): string {
  if (memoizedCredentialRoot === undefined) {
    memoizedCredentialRoot = resolveCredentialRootFromEnv();
  }
  return memoizedCredentialRoot;
}

function stageflowHomeNotWritableMessage(resolvedPath: string): string {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return `STAGEFLOW_HOME is not writable (${resolvedPath}). Running as uid=${uid} gid=${gid}. Try: sudo chown -R ${uid}:${gid} ${resolvedPath}`;
}

function isStageflowHomeWritable(home: string): boolean {
  try {
    accessSync(home, constants.W_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const parent = path.dirname(home);
      if (parent === home) {
        return false;
      }
      try {
        accessSync(parent, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function assertStageflowHomeWritable(): void {
  const home = globalStageflowHome();
  if (!isStageflowHomeWritable(home)) {
    throw new StageflowHomeError(
      stageflowHomeNotWritableMessage(home),
      "stageflow_home_not_writable",
    );
  }
}

export function ensureGlobalHome(): string {
  assertStageflowHomeWritable();
  const globalHome = globalStageflowHome();
  createOwnerOnlyDirectory(globalHome);
  const agentDir = path.join(globalHome, "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(agentDir, 0o700);
  } catch {
    // best-effort on non-POSIX
  }
  return globalHome;
}
