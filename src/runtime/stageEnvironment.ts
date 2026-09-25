import { SF_STAGE_WORKER } from "./stageWorkerProtocol.js";

export const STAGE_ENV_PASSTHROUGH = "STAGEFLOW_STAGE_ENV_PASSTHROUGH";
export const STAGE_ENV_ALLOW = "STAGEFLOW_STAGE_ENV_ALLOW";

/** Names copied from Host when present (exact-name allowlist; no prefix wildcards). */
export const STAGE_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "STAGEFLOW_HOME",
];

const PROVIDER_AND_CLOUD_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_FILE",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY",
  "XAI_API_KEY",
  "COHERE_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GCLOUD_PROJECT",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN_FILE",
  "GH_TOKEN_FILE",
] as const;

/** Never grantable — even via secrets `as: env`. */
export const FOREVER_DENIED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "STAGEFLOW_CONTROL_TOKEN",
  "STAGEFLOW_CONTROL_TOKEN_FILE",
  "STAGEFLOW_READ_TOKEN",
  "STAGEFLOW_READ_TOKEN_FILE",
]);

/** Blocked from ambient / ALLOW / PASSTHROUGH; `as: env` grants may still inject. */
export const AMBIENT_BLOCKED_ENV_NAMES: ReadonlySet<string> = new Set([
  ...FOREVER_DENIED_SECRET_NAMES,
  ...PROVIDER_AND_CLOUD_NAMES,
]);

/** Full denylist surface for docs and health (union of forever + ambient-blocked). */
export const STAGE_ENV_DENYLIST: readonly string[] = [
  ...FOREVER_DENIED_SECRET_NAMES,
  ...PROVIDER_AND_CLOUD_NAMES,
];

export type ResolvedStageGrants = {
  env: Record<string, string>;
  registeredSecretNames: readonly string[];
  declaredSecretNames: readonly string[];
};

export type BuildStageEnvironmentInput = {
  hostEnv: NodeJS.ProcessEnv;
  runVars?: Record<string, string>;
  cacheVars?: Record<string, string>;
  grants?: ResolvedStageGrants;
  /** Per-attempt empty HOME (KTD7). When set, overrides Host HOME. */
  attemptHome?: string;
  /** Package version for PASSTHROUGH deprecation text. */
  packageVersion?: string;
};

export type BuildStageEnvironmentResult = {
  env: Record<string, string>;
  warnings: string[];
  passthroughActive: boolean;
};

function copyDefined(
  out: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv,
  names: readonly string[],
): void {
  for (const name of names) {
    const value = hostEnv[name];
    if (value !== undefined && value !== "") {
      out[name] = value;
    }
  }
}

export function isForeverDeniedSecret(name: string): boolean {
  if (FOREVER_DENIED_SECRET_NAMES.has(name)) return true;
  return name.startsWith("STAGEFLOW_CONTROL_TOKEN_");
}

export function isAmbientBlockedEnv(name: string): boolean {
  return isForeverDeniedSecret(name) || AMBIENT_BLOCKED_ENV_NAMES.has(name);
}

function stripForeverDenied(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isForeverDeniedSecret(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseAllowList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function passthroughDeprecationTarget(version: string): string {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(parts[0]) ? parts[0]! : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1]! : 0;
  return `${major}.${minor + 2}.0`;
}

/**
 * Construct the stage child environment. Exact-name allowlist only — never a
 * raw spread of Host env, and never a STAGEFLOW_* prefix passthrough.
 */
export function buildStageEnvironment(
  input: BuildStageEnvironmentInput,
): BuildStageEnvironmentResult {
  const hostEnv = input.hostEnv;
  const warnings: string[] = [];
  const grants = input.grants ?? {
    env: {},
    registeredSecretNames: [],
    declaredSecretNames: [],
  };
  const declared = new Set(grants.declaredSecretNames);
  const registered = new Set(grants.registeredSecretNames);

  const env: Record<string, string> = {};

  copyDefined(env, hostEnv, STAGE_ENV_ALLOWLIST);

  if (input.cacheVars) {
    Object.assign(env, input.cacheVars);
  }

  if (input.runVars) {
    Object.assign(env, input.runVars);
  }

  const allowNames = parseAllowList(hostEnv[STAGE_ENV_ALLOW]);
  for (const name of allowNames) {
    if (AMBIENT_BLOCKED_ENV_NAMES.has(name)) continue;
    const value = hostEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }

  const passthroughRaw = hostEnv[STAGE_ENV_PASSTHROUGH]?.trim();
  const passthroughActive = passthroughRaw === "all";
  if (passthroughActive) {
    const version = input.packageVersion ?? "0.24.0";
    const removeBy = passthroughDeprecationTarget(version);
    warnings.push(
      `${STAGE_ENV_PASSTHROUGH}=all is deprecated and will be removed in ${removeBy}; prefer ${STAGE_ENV_ALLOW} or stage secrets:`,
    );
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value === undefined) continue;
      if (AMBIENT_BLOCKED_ENV_NAMES.has(key)) continue;
      if (registered.has(key) && !declared.has(key)) continue;
      if (
        key.endsWith("_FILE") &&
        registered.has(key.slice(0, -"_FILE".length)) &&
        !declared.has(key.slice(0, -"_FILE".length))
      ) {
        continue;
      }
      if (Object.hasOwn(env, key)) continue;
      env[key] = value;
    }
  }

  // Grants after ambient so explicit `as: env` can inject ambient-blocked names
  // (e.g. GITHUB_TOKEN). Forever-denied names are stripped below.
  Object.assign(env, grants.env);

  if (input.attemptHome !== undefined) {
    env.HOME = input.attemptHome;
  }

  env[SF_STAGE_WORKER] = "1";

  return {
    env: stripForeverDenied(env),
    warnings,
    passthroughActive,
  };
}

export function envNameSet(env: Record<string, string>): Set<string> {
  return new Set(Object.keys(env));
}
