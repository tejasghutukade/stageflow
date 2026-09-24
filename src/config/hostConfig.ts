import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { globalStageflowHome } from "../project/globalHome.js";
import { readSecretFromEnvOrFile } from "./secretFromEnvOrFile.js";

export class HostConfigError extends Error {
  readonly code: "config_unknown_key" | "config_invalid";
  readonly key?: string;

  constructor(
    message: string,
    code: "config_unknown_key" | "config_invalid",
    key?: string,
  ) {
    super(message);
    this.name = "HostConfigError";
    this.code = code;
    this.key = key;
  }
}

/** Env keys that are known STAGEFLOW_* (or dynamic families) so unknown-key check accepts them. */
export const KNOWN_STAGEFLOW_ENV_KEYS = new Set<string>([
  "STAGEFLOW_HOME",
  "STAGEFLOW_BIND",
  "STAGEFLOW_ALLOWED_HOSTS",
  "STAGEFLOW_CONTROL_TOKEN",
  "STAGEFLOW_CONTROL_TOKEN_FILE",
  "STAGEFLOW_READ_TOKEN",
  "STAGEFLOW_READ_TOKEN_FILE",
  "STAGEFLOW_ALLOW_UNKNOWN_CONFIG",
  "STAGEFLOW_MAX_CONCURRENT_RUNS",
  "STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT",
  "STAGEFLOW_MAX_QUEUED",
  "STAGEFLOW_REQUIRE_PROVIDERS",
  "STAGEFLOW_A2A_CONFIG",
  "STAGEFLOW_ACTIVITY_TEXT_LIMIT",
  "STAGEFLOW_ACTIVITY_VERBOSE",
  "STAGEFLOW_CURSOR_EXTENSION",
  "STAGEFLOW_NO_OPEN",
  "STAGEFLOW_OPERATOR_CWD",
  "STAGEFLOW_OPERATOR_AGENT_DIR",
  "STAGEFLOW_LEGACY_YAML",
  "STAGEFLOW_LOG_FORMAT",
  "STAGEFLOW_LOG_LEVEL",
  "STAGEFLOW_LOG_MAX_LINE_BYTES",
  "STAGEFLOW_MCP_STATELESS",
  "STAGEFLOW_DISK_WARN_BYTES",
  "STAGEFLOW_MIN_FREE_DISK_BYTES",
  "STAGEFLOW_BARE_CACHE_TTL_MS",
  "STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES",
  "STAGEFLOW_SQLITE_BUSY_TIMEOUT_MS",
  "STAGEFLOW_RUN_BRANCH_TEMPLATE",
  "STAGEFLOW_AUTO_RESUME_INTERRUPTED",
  "STAGEFLOW_MAX_AUTO_RESUMES",
  "STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS",
  "STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN",
  "STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES",
  "STAGEFLOW_STAGE_EXECUTION",
  "STAGEFLOW_STAGE_ENV_ALLOW",
  "STAGEFLOW_STAGE_ENV_PASSTHROUGH",
  "STAGEFLOW_GC_INTERVAL_MS",
  "STAGEFLOW_MAX_CONNECTIONS",
  "STAGEFLOW_REQUEST_TIMEOUT_MS",
  "STAGEFLOW_AUTOSTART_TIMEOUT_MS",
  "STAGEFLOW_NO_AUTOSTART",
  "STAGEFLOW_SERVICE_PORT",
  "STAGEFLOW_SHUTDOWN_GRACE_MS",
  "STAGEFLOW_TOOLCHAIN_MANIFEST",
  "STAGEFLOW_SECRET_REGISTRY",
]);

const KNOWN_ENV_PREFIXES = [
  "STAGEFLOW_PROVIDER_",
  "STAGEFLOW_SLIM_",
  "STAGEFLOW_PURGE_",
  "STAGEFLOW_CONTROL_TOKEN_",
] as const;

const FILE_KEY_TO_FIELD = {
  max_concurrent_runs: "maxConcurrentRuns",
  max_concurrent_runs_per_project: "maxConcurrentRunsPerProject",
  max_queued: "maxQueued",
  require_providers: "requireProviders",
  trust_workspace_config: "trustWorkspaceConfig",
  allow_unknown_config: "allowUnknownConfig",
  callers: "callers",
} as const;

type FileField = (typeof FILE_KEY_TO_FIELD)[keyof typeof FILE_KEY_TO_FIELD];

/** Per-caller concurrent-active quota from host `callers:` config. */
export type CallerQuotaConfig = {
  maxConcurrent: number;
};

export type HostConfig = {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number | undefined;
  maxQueued: number;
  requireProviders: string[];
  trustWorkspaceConfig: string[];
  allowUnknownConfig: boolean;
  controlToken: string | undefined;
  readToken: string | undefined;
  /** caller_id → quota; empty when unset. */
  callers: Record<string, CallerQuotaConfig>;
  /** Absolute path of config.yaml when loaded; undefined if absent. */
  configFilePath: string | undefined;
  warnings: string[];
  /** True when maxConcurrentRuns came from override, env, or file (not bare default). */
  maxConcurrentRunsExplicit: boolean;
};

export type HostConfigOverrides = {
  maxConcurrentRuns?: number;
};

export type HostConfigSecretsEcho = {
  controlToken: "set" | "unset";
  readToken: "set" | "unset";
};

export type HostConfigPublicEcho = {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number | undefined;
  maxQueued: number;
  requireProviders: string[];
  trustWorkspaceConfig: string[];
  allowUnknownConfig: boolean;
  callers: Record<string, CallerQuotaConfig>;
  secrets: HostConfigSecretsEcho;
};

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_QUEUED = 32;

function isKnownStageflowEnvKey(key: string): boolean {
  if (KNOWN_STAGEFLOW_ENV_KEYS.has(key)) return true;
  return KNOWN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function parsePositiveInt(
  raw: string,
  key: string,
  opts?: { allowZero?: boolean },
): number {
  const n = Number.parseInt(raw, 10);
  const min = opts?.allowZero ? 0 : 1;
  if (!Number.isFinite(n) || n < min || String(n) !== raw.trim()) {
    throw new HostConfigError(
      `Invalid value for ${key}: ${JSON.stringify(raw)}`,
      "config_invalid",
      key,
    );
  }
  return n;
}

function parseStringList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(raw: string, key: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false" || normalized === "") {
    return false;
  }
  throw new HostConfigError(
    `Invalid boolean for ${key}: ${JSON.stringify(raw)}`,
    "config_invalid",
    key,
  );
}

function assertUnknownEnvKeys(
  env: NodeJS.ProcessEnv,
  allowUnknown: boolean,
  warnings: string[],
): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith("STAGEFLOW_")) continue;
    if (isKnownStageflowEnvKey(key)) continue;
    const message = `Unknown environment variable ${key}`;
    if (allowUnknown) {
      warnings.push(message);
      continue;
    }
    throw new HostConfigError(message, "config_unknown_key", key);
  }
}

function loadFileLayers(
  filePath: string | undefined,
): { values: Partial<Record<FileField, unknown>>; warnings: string[] } {
  const warnings: string[] = [];
  if (filePath === undefined || !existsSync(filePath)) {
    return { values: {}, warnings };
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HostConfigError(
      `Invalid config file ${filePath}: ${detail}`,
      "config_invalid",
    );
  }
  if (raw === null || raw === undefined) {
    return { values: {}, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HostConfigError(
      `config.yaml must be a mapping`,
      "config_invalid",
    );
  }
  const values: Partial<Record<FileField, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = FILE_KEY_TO_FIELD[key as keyof typeof FILE_KEY_TO_FIELD];
    if (field === undefined) {
      throw new HostConfigError(
        `Unknown config key "${key}" in ${filePath}`,
        "config_unknown_key",
        key,
      );
    }
    values[field] = value;
  }
  return { values, warnings };
}

function coerceFileNumber(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parsePositiveInt(value, key, {
      allowZero: key.includes("queued") || key.includes("per_project"),
    });
  }
  throw new HostConfigError(
    `Invalid value for ${key}`,
    "config_invalid",
    key,
  );
}

function coerceFileStringList(value: unknown, key: string): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.map((v) => v.trim()).filter((v) => v.length > 0);
  }
  if (typeof value === "string") return parseStringList(value);
  throw new HostConfigError(
    `Invalid value for ${key}; expected string list`,
    "config_invalid",
    key,
  );
}

function coerceFileBool(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return parseBool(value, key);
  throw new HostConfigError(
    `Invalid boolean for ${key}`,
    "config_invalid",
    key,
  );
}

function coerceCallers(
  value: unknown,
  key: string,
): Record<string, CallerQuotaConfig> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HostConfigError(
      `Invalid value for ${key}; expected mapping of caller_id → { max_concurrent }`,
      "config_invalid",
      key,
    );
  }
  const out: Record<string, CallerQuotaConfig> = {};
  for (const [rawId, rawEntry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const callerId = rawId.trim().toLowerCase();
    if (callerId.length === 0) {
      throw new HostConfigError(
        `Invalid empty caller id in ${key}`,
        "config_invalid",
        key,
      );
    }
    if (
      rawEntry === null ||
      typeof rawEntry !== "object" ||
      Array.isArray(rawEntry)
    ) {
      throw new HostConfigError(
        `Invalid value for ${key}.${rawId}; expected { max_concurrent }`,
        "config_invalid",
        key,
      );
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry.max_concurrent === undefined) {
      throw new HostConfigError(
        `Missing max_concurrent for ${key}.${rawId}`,
        "config_invalid",
        key,
      );
    }
    const n = coerceFileNumber(entry.max_concurrent, `${key}.${rawId}.max_concurrent`);
    if (!Number.isInteger(n) || n < 1) {
      throw new HostConfigError(
        `Invalid max_concurrent for ${key}.${rawId}`,
        "config_invalid",
        key,
      );
    }
    for (const sub of Object.keys(entry)) {
      if (sub !== "max_concurrent") {
        throw new HostConfigError(
          `Unknown key "${sub}" under ${key}.${rawId}`,
          "config_unknown_key",
          sub,
        );
      }
    }
    out[callerId] = { maxConcurrent: n };
  }
  return out;
}

/**
 * Assemble HostConfig once at boot. Precedence: overrides (CLI flags) > env > file > default.
 */
export function loadHostConfig(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  overrides?: HostConfigOverrides;
  configFilePath?: string | null;
}): HostConfig {
  const env = options?.env ?? process.env;
  const warnings: string[] = [];
  const homeDir = options?.homeDir ?? globalStageflowHome();
  const configFilePath =
    options?.configFilePath === null
      ? undefined
      : (options?.configFilePath ?? path.join(homeDir, "config.yaml"));

  const allowUnknownFromEnv = env.STAGEFLOW_ALLOW_UNKNOWN_CONFIG;
  const allowUnknownConfig =
    allowUnknownFromEnv !== undefined && allowUnknownFromEnv.length > 0
      ? parseBool(allowUnknownFromEnv, "STAGEFLOW_ALLOW_UNKNOWN_CONFIG")
      : false;

  if (allowUnknownConfig) {
    warnings.push(
      "STAGEFLOW_ALLOW_UNKNOWN_CONFIG=1: unknown STAGEFLOW_* keys will warn instead of failing boot",
    );
  }

  assertUnknownEnvKeys(env, allowUnknownConfig, warnings);

  const file = loadFileLayers(
    configFilePath !== undefined && existsSync(configFilePath)
      ? configFilePath
      : undefined,
  );
  warnings.push(...file.warnings);

  let maxConcurrentRuns = DEFAULT_MAX_CONCURRENT;
  let maxConcurrentRunsExplicit = false;
  if (file.values.maxConcurrentRuns !== undefined) {
    const n = coerceFileNumber(
      file.values.maxConcurrentRuns,
      "max_concurrent_runs",
    );
    if (!Number.isInteger(n) || n < 1) {
      throw new HostConfigError(
        `Invalid value for max_concurrent_runs`,
        "config_invalid",
        "max_concurrent_runs",
      );
    }
    maxConcurrentRuns = n;
    maxConcurrentRunsExplicit = true;
  }
  if (env.STAGEFLOW_MAX_CONCURRENT_RUNS !== undefined) {
    maxConcurrentRuns = parsePositiveInt(
      env.STAGEFLOW_MAX_CONCURRENT_RUNS,
      "STAGEFLOW_MAX_CONCURRENT_RUNS",
    );
    maxConcurrentRunsExplicit = true;
  }
  if (options?.overrides?.maxConcurrentRuns !== undefined) {
    maxConcurrentRuns = options.overrides.maxConcurrentRuns;
    maxConcurrentRunsExplicit = true;
  }

  let maxConcurrentRunsPerProject: number | undefined;
  if (file.values.maxConcurrentRunsPerProject !== undefined) {
    const n = coerceFileNumber(
      file.values.maxConcurrentRunsPerProject,
      "max_concurrent_runs_per_project",
    );
    if (!Number.isInteger(n) || n < 1) {
      throw new HostConfigError(
        `Invalid value for max_concurrent_runs_per_project`,
        "config_invalid",
        "max_concurrent_runs_per_project",
      );
    }
    maxConcurrentRunsPerProject = n;
  }
  if (env.STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT !== undefined) {
    maxConcurrentRunsPerProject = parsePositiveInt(
      env.STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT,
      "STAGEFLOW_MAX_CONCURRENT_RUNS_PER_PROJECT",
    );
  }

  let maxQueued = DEFAULT_MAX_QUEUED;
  if (file.values.maxQueued !== undefined) {
    const n = coerceFileNumber(file.values.maxQueued, "max_queued");
    if (!Number.isInteger(n) || n < 0) {
      throw new HostConfigError(
        `Invalid value for max_queued`,
        "config_invalid",
        "max_queued",
      );
    }
    maxQueued = n;
  }
  if (env.STAGEFLOW_MAX_QUEUED !== undefined) {
    maxQueued = parsePositiveInt(env.STAGEFLOW_MAX_QUEUED, "STAGEFLOW_MAX_QUEUED", {
      allowZero: true,
    });
  }

  let requireProviders: string[] = [];
  if (file.values.requireProviders !== undefined) {
    requireProviders = coerceFileStringList(
      file.values.requireProviders,
      "require_providers",
    );
  }
  if (env.STAGEFLOW_REQUIRE_PROVIDERS !== undefined) {
    requireProviders = parseStringList(env.STAGEFLOW_REQUIRE_PROVIDERS);
  }

  let trustWorkspaceConfig: string[] = [];
  if (file.values.trustWorkspaceConfig !== undefined) {
    trustWorkspaceConfig = coerceFileStringList(
      file.values.trustWorkspaceConfig,
      "trust_workspace_config",
    );
  }

  let allowUnknownFromFile = allowUnknownConfig;
  if (file.values.allowUnknownConfig !== undefined) {
    allowUnknownFromFile = coerceFileBool(
      file.values.allowUnknownConfig,
      "allow_unknown_config",
    );
  }
  // Env already applied above for the unknown-key scan; file cannot enable after the fact.
  void allowUnknownFromFile;

  const controlToken = readSecretFromEnvOrFile(env, "STAGEFLOW_CONTROL_TOKEN");
  const readToken = readSecretFromEnvOrFile(env, "STAGEFLOW_READ_TOKEN");

  let callers: Record<string, CallerQuotaConfig> = {};
  if (file.values.callers !== undefined) {
    callers = coerceCallers(file.values.callers, "callers");
  }

  return {
    maxConcurrentRuns,
    maxConcurrentRunsPerProject,
    maxQueued,
    requireProviders,
    trustWorkspaceConfig,
    allowUnknownConfig,
    controlToken,
    readToken,
    callers,
    configFilePath:
      configFilePath !== undefined && existsSync(configFilePath)
        ? configFilePath
        : undefined,
    warnings,
    maxConcurrentRunsExplicit,
  };
}

export function redactHostConfig(config: HostConfig): HostConfigPublicEcho {
  return {
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxConcurrentRunsPerProject: config.maxConcurrentRunsPerProject,
    maxQueued: config.maxQueued,
    requireProviders: [...config.requireProviders],
    trustWorkspaceConfig: [...config.trustWorkspaceConfig],
    allowUnknownConfig: config.allowUnknownConfig,
    callers: { ...config.callers },
    secrets: {
      controlToken: config.controlToken ? "set" : "unset",
      readToken: config.readToken ? "set" : "unset",
    },
  };
}
