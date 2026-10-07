import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { ensureGlobalHome } from "../project/globalHome.js";
import {
  resolveProjectContext,
  type ProjectContext,
} from "../project/resolveProjectContext.js";
import {
  parseCredentialSource,
  readCredentialSourceFromContext,
  writeCredentialSourceToContext,
  type CredentialSource,
} from "./settingsFile.js";

export {
  parseCredentialSource,
  readCredentialSourceFromContext,
  writeCredentialSourceToContext,
};

export type CredentialBinding = {
  source: CredentialSource;
  authPath: string;
  provisional: boolean;
};

export type ResolveCredentialBindingOptions = {
  agentAuthPath?: string;
};

export function sfOwnedAgentDir(): string {
  return path.join(ensureGlobalHome(), "agent");
}

export function sfOwnedAuthPath(): string {
  return path.join(sfOwnedAgentDir(), "auth.json");
}

export const STAGEFLOW_AGENT_AUTH_PATH_ENV = "STAGEFLOW_AGENT_AUTH_PATH";

/** @deprecated Use STAGEFLOW_AGENT_AUTH_PATH_ENV. */
export const PI_HOME_AUTH_PATH_ENV = STAGEFLOW_AGENT_AUTH_PATH_ENV;

export function stageflowAgentAuthPath(override?: string): string {
  if (override !== undefined) {
    return path.resolve(override);
  }
  const fromEnv =
    process.env[STAGEFLOW_AGENT_AUTH_PATH_ENV]?.trim() ||
    process.env.STAGEFLOW_PI_HOME_AUTH_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return sfOwnedAuthPath();
}

/** @deprecated Use stageflowAgentAuthPath */
export function piHomeAuthPath(override?: string): string {
  return stageflowAgentAuthPath(override);
}

export function isUsableAuthFile(authPath: string): boolean {
  if (!existsSync(authPath)) return false;
  try {
    const content = readFileSync(authPath, "utf8").trim();
    return content !== "" && content !== "{}";
  } catch {
    return false;
  }
}

export function ensureSfOwnedAuthStore(): string {
  ensureGlobalHome();
  const authPath = sfOwnedAuthPath();
  if (!existsSync(authPath)) {
    writeFileSync(authPath, "{}\n", { encoding: "utf8", mode: 0o600 });
  }
  try {
    chmodSync(authPath, 0o600);
  } catch {
    // best-effort on non-POSIX
  }
  return authPath;
}

const explicitAuthPath = new AsyncLocalStorage<string>();

/** Use this auth file for credential binding and do not create the operator home. */
export function runWithExplicitAuthPath<T>(
  authPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return explicitAuthPath.run(path.resolve(authPath), fn);
}

export function currentExplicitAuthPath(): string | undefined {
  return explicitAuthPath.getStore();
}

export function resolveCredentialBinding(
  ctx: ProjectContext | string,
  _options: ResolveCredentialBindingOptions = {},
): CredentialBinding {
  const projectCtx =
    typeof ctx === "string" ? resolveProjectContext(ctx) : ctx;
  const persisted = readCredentialSourceFromContext(projectCtx);
  const authPath = ensureSfOwnedAuthStore();
  return {
    source: "sf_owned",
    authPath,
    provisional: persisted === undefined,
  };
}

export {
  readCredentialSourceFromFile,
  writeCredentialSourceToFile,
} from "./settingsFile.js";
