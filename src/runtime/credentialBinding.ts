import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeRootFor } from "../runstore/paths.js";
import {
  parseCredentialSource,
  readCredentialSourceFromFile,
  writeCredentialSourceToFile,
  type CredentialSource,
} from "./settingsFile.js";

export {
  parseCredentialSource,
  readCredentialSourceFromFile,
  writeCredentialSourceToFile,
};

export type CredentialBinding = {
  source: CredentialSource;
  authPath: string;
  provisional: boolean;
};

export type ResolveCredentialBindingOptions = {
  piHomeAuthPath?: string;
};

export function sfOwnedAgentDir(cwd: string): string {
  return path.join(storeRootFor(cwd), "agent");
}

export function sfOwnedAuthPath(cwd: string): string {
  return path.join(sfOwnedAgentDir(cwd), "auth.json");
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

export function ensureSfOwnedAuthStore(cwd: string): string {
  const storeRoot = storeRootFor(cwd);
  mkdirSync(storeRoot, { recursive: true });
  const agentDir = sfOwnedAgentDir(cwd);
  mkdirSync(agentDir, { recursive: true });
  try {
    chmodSync(agentDir, 0o700);
  } catch {
    // best-effort on non-POSIX
  }
  const authPath = sfOwnedAuthPath(cwd);
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
  cwd: string,
  options: ResolveCredentialBindingOptions = {},
): CredentialBinding {
  const piHome = piHomeAuthPath(options.piHomeAuthPath);
  const persisted = readCredentialSourceFromFile(cwd);

  if (persisted !== undefined) {
    if (persisted === "sf_owned") {
      return {
        source: "sf_owned",
        authPath: ensureSfOwnedAuthStore(cwd),
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
    authPath: ensureSfOwnedAuthStore(cwd),
    provisional: true,
  };
}
