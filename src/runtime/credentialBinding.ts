import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
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
  piHomeAuthPath?: string;
};

export function sfOwnedAgentDir(): string {
  return path.join(ensureGlobalHome(), "agent");
}

export function sfOwnedAuthPath(): string {
  return path.join(sfOwnedAgentDir(), "auth.json");
}

export function piHomeAuthPath(
  override?: string,
): string {
  return (
    override ??
    path.join(os.homedir(), ".pi", "agent", "auth.json")
  );
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

export function resolveCredentialBinding(
  ctx: ProjectContext | string,
  options: ResolveCredentialBindingOptions = {},
): CredentialBinding {
  const projectCtx =
    typeof ctx === "string" ? resolveProjectContext(ctx) : ctx;
  const piHome = piHomeAuthPath(options.piHomeAuthPath);
  const persisted = readCredentialSourceFromContext(projectCtx);

  if (persisted !== undefined) {
    if (persisted === "sf_owned") {
      return {
        source: "sf_owned",
        authPath: ensureSfOwnedAuthStore(),
        provisional: false,
      };
    }
    return {
      source: "pi_home",
      authPath: piHome,
      provisional: false,
    };
  }

  if (isUsableAuthFile(piHome)) {
    return {
      source: "pi_home",
      authPath: piHome,
      provisional: true,
    };
  }

  return {
    source: "sf_owned",
    authPath: ensureSfOwnedAuthStore(),
    provisional: true,
  };
}

export {
  readCredentialSourceFromFile,
  writeCredentialSourceToFile,
} from "./settingsFile.js";
