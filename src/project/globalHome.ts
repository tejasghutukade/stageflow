import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function globalStageflowHome(): string {
  return path.join(os.homedir(), ".stageflow");
}

export function ensureGlobalHome(): string {
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
