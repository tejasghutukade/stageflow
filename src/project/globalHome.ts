import { accessSync, chmodSync, constants, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function resetGlobalStageflowHomeForTests(): void {
  memoizedHome = undefined;
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

export function globalStageflowHome(): string {
  if (memoizedHome === undefined) {
    memoizedHome = resolveStageflowHomeFromEnv();
    process.env.STAGEFLOW_HOME = memoizedHome;
  }
  return memoizedHome;
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
  mkdirSync(globalHome, { recursive: true });
  const agentDir = path.join(globalHome, "agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    chmodSync(agentDir, 0o700);
  } catch {
    // best-effort on non-POSIX
  }
  return globalHome;
}
