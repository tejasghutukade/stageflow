import { readFileSync } from "node:fs";
import { shouldRegisterValue } from "../logging/redact.js";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  attemptCredentialsDir,
  cleanupCredentialsDir,
  ensureStageAskpassHelper,
  materialiseCredentialFile,
  materialiseSecretBytes,
  readFileCredentialRegistry,
} from "./credentialMaterialisation.js";
import {
  defaultSecretDelivery,
  type StageSecretDecl,
} from "./stageSecretDecl.js";
import type { ResolvedStageGrants } from "./stageEnvironment.js";
import { isForeverDeniedSecret } from "./stageEnvironment.js";

export type SecretRegistryEntry =
  | { kind: "env"; name: string }
  | { kind: "file"; name: string; source: string; pointerVar: string };

export type SecretRegistry = Map<string, SecretRegistryEntry>;

export class SecretUnavailableError extends Error {
  readonly code = "secret_unavailable" as const;
  readonly secretName: string;

  constructor(secretName: string) {
    super(`secret_unavailable: registered secret "${secretName}" has no value on this Host`);
    this.name = "SecretUnavailableError";
    this.secretName = secretName;
  }
}

function readEnvSecretValue(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const plain = env[name];
  const fileKey = `${name}_FILE`;
  const filePath = env[fileKey];
  const hasPlain = plain !== undefined && plain.length > 0;
  const hasFile = filePath !== undefined && filePath.length > 0;
  if (hasPlain && hasFile) {
    throw new Error(`Set only one of ${name} or ${fileKey}, not both`);
  }
  if (hasFile) {
    return readFileSync(filePath!, "utf8").replace(/\r?\n$/, "");
  }
  if (hasPlain) return plain;
  return undefined;
}

/** Host-owned secret registry: env NAME/_FILE plus file-credentials under $STAGEFLOW_HOME. */
export function loadSecretRegistry(
  env: NodeJS.ProcessEnv = process.env,
  home: string = globalStageflowHome(),
): SecretRegistry {
  const registry: SecretRegistry = new Map();
  const fileCreds = readFileCredentialRegistry(home);
  for (const [name, entry] of Object.entries(fileCreds)) {
    if (isForeverDeniedSecret(name)) continue;
    registry.set(name, {
      kind: "file",
      name,
      source: entry.source,
      pointerVar: entry.pointerVar,
    });
  }
  // Well-known env secrets are always registered when present or when declared
  // (presence checked at resolve time). Register common names so validate can
  // distinguish unknown vs unavailable.
  for (const name of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
  ]) {
    if (!registry.has(name)) {
      registry.set(name, { kind: "env", name });
    }
  }
  // Any Host env var with a sibling `_FILE` or non-empty value that looks like a
  // registered secret name from STAGEFLOW_SECRET_REGISTRY (comma list) is also
  // env-kind.
  const extra = env.STAGEFLOW_SECRET_REGISTRY?.split(",") ?? [];
  for (const raw of extra) {
    const name = raw.trim();
    if (!name || isForeverDeniedSecret(name) || registry.has(name)) continue;
    registry.set(name, { kind: "env", name });
  }
  return registry;
}

export type ResolveStageSecretsInput = {
  decls: readonly StageSecretDecl[] | undefined;
  registry: SecretRegistry;
  hostEnv: NodeJS.ProcessEnv;
  attemptDir: string;
  home?: string;
};

export type ResolveStageSecretsResult = {
  grants: ResolvedStageGrants;
  warnings: string[];
  knownValues: Array<{ name: string; value: string }>;
  credentialDirs: string[];
};

/** Presence-only check (no materialisation) for preflight / start gates. */
export function assertSecretPresent(
  name: string,
  registry: SecretRegistry,
  hostEnv: NodeJS.ProcessEnv,
): void {
  if (isForeverDeniedSecret(name)) {
    throw new Error(`secret "${name}" is permanently denied`);
  }
  const entry = registry.get(name);
  if (entry === undefined) {
    throw new Error(`stage.unknown_secret: "${name}"`);
  }
  if (entry.kind === "file") {
    try {
      readFileSync(entry.source, "utf8");
    } catch {
      throw new SecretUnavailableError(name);
    }
    return;
  }
  const value = readEnvSecretValue(name, hostEnv);
  if (value === undefined || value === "") {
    throw new SecretUnavailableError(name);
  }
}

export function resolveStageSecrets(
  input: ResolveStageSecretsInput,
): ResolveStageSecretsResult {
  const decls = input.decls ?? [];
  const warnings: string[] = [];
  const grantEnv: Record<string, string> = {};
  const knownValues: Array<{ name: string; value: string }> = [];
  const credentialDirs: string[] = [];
  const registeredNames = [...input.registry.keys()];
  const declaredNames = decls.map((d) => d.name);

  for (const decl of decls) {
    if (isForeverDeniedSecret(decl.name)) {
      throw new Error(`secret "${decl.name}" is permanently denied`);
    }
    const entry = input.registry.get(decl.name);
    if (entry === undefined) {
      throw new Error(`stage.unknown_secret: "${decl.name}"`);
    }

    if (entry.kind === "file") {
      const destDir = attemptCredentialsDir(input.attemptDir, decl.name);
      const homeRoot = input.home ?? globalStageflowHome();
      const copied = materialiseCredentialFile({
        sourcePath: entry.source,
        destDir,
        allowedRoot: homeRoot,
      });
      credentialDirs.push(destDir);
      grantEnv[entry.pointerVar] = copied.destPath;
      const contents = readFileSync(copied.destPath, "utf8");
      if (shouldRegisterValue(contents)) {
        knownValues.push({ name: decl.name, value: contents });
      }
      if (decl.as === "env") {
        warnings.push(
          `secrets: ${decl.name} granted as: env (value present in stage environment)`,
        );
        grantEnv[decl.name] = contents;
      }
      continue;
    }

    const value = readEnvSecretValue(decl.name, input.hostEnv);
    if (value === undefined || value === "") {
      throw new SecretUnavailableError(decl.name);
    }
    knownValues.push({ name: decl.name, value });

    const delivery =
      decl.as === "env" ? "env" : defaultSecretDelivery(decl.name);

    if (delivery === "env") {
      if (decl.as === "env") {
        warnings.push(
          `secrets: ${decl.name} granted as: env (value present in stage environment)`,
        );
      }
      grantEnv[decl.name] = value;
      continue;
    }

    const destDir = attemptCredentialsDir(input.attemptDir, decl.name);
    const tokenFile = materialiseSecretBytes({
      contents: value,
      destDir,
      destBasename: "token",
    });
    credentialDirs.push(destDir);
    const askpass = ensureStageAskpassHelper(input.home);
    grantEnv.GIT_ASKPASS = askpass;
    grantEnv.GIT_TERMINAL_PROMPT = "0";
    grantEnv.STAGEFLOW_GIT_ASKPASS_TOKEN_FILE = tokenFile.destPath;
  }

  return {
    grants: {
      env: grantEnv,
      registeredSecretNames: registeredNames,
      declaredSecretNames: declaredNames,
    },
    warnings,
    knownValues,
    credentialDirs,
  };
}

export { cleanupCredentialsDir };
