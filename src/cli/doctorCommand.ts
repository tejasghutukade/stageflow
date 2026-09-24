import { accessSync, constants } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { getCredentialSourceSettings } from "../agent/providerAuth.js";
import {
  probeGitVersion,
  runReadyzChecks,
  type ReadyzResult,
} from "../diagnostics/checks.js";
import { findMissingMcpCommands } from "../preflight/mcpCommands.js";
import { assertBashAvailable } from "../preflight/bash.js";
import { warnMissingCaPaths } from "../preflight/tls.js";
import {
  runPipelinePreflight,
  type PipelinePreflightResult,
} from "../preflight/pipelinePreflight.js";
import { loadPipelineOutcome } from "../config/loadPipeline.js";
import { MCP_CATALOG_FILENAME } from "../config/resolveStageMcpServers.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { createRunStore } from "../runstore/createStore.js";
import {
  readFilesystemSize,
  resolveMinFreeDiskFloor,
} from "../runstore/diskUsage.js";
import type { RunStore } from "../runstore/port.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail" | "skipped";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  code?: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
  preflight?: PipelinePreflightResult;
};

export type DoctorCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: DoctorCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const PROVIDER_KEY_RE = /^STAGEFLOW_PROVIDER_([A-Za-z0-9_]+)_API_KEY$/;
const PROVIDER_FILE_RE = /^STAGEFLOW_PROVIDER_([A-Za-z0-9_]+)_API_KEY_FILE$/;

function mapReadyzChecks(result: ReadyzResult, home: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const { checks } = result;

  if (checks.store_openable) {
    out.push({
      id: "store_openable",
      status: "pass",
      message: "Run store is openable",
    });
  } else {
    out.push({
      id: "store_openable",
      status: "fail",
      code: "store_not_openable",
      message: "Run store could not be opened or queried",
    });
  }

  if (checks.home_writable) {
    out.push({
      id: "home_writable",
      status: "pass",
      message: `${home} is writable`,
    });
  } else {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    out.push({
      id: "home_writable",
      status: "fail",
      code: "home_not_writable",
      message: `STAGEFLOW_HOME is not writable (${home}). Running as uid=${uid} gid=${gid}. Try: sudo chown -R ${uid}:${gid} ${home}`,
    });
  }

  if (checks.migrations_complete) {
    out.push({
      id: "migrations_complete",
      status: "pass",
      message: "Store migrations are complete",
    });
  } else {
    out.push({
      id: "migrations_complete",
      status: "fail",
      code: "migrations_incomplete",
      message: "Store schema migrations are incomplete",
    });
  }

  return out;
}

async function gitDoctorCheck(gitPresent: boolean): Promise<DoctorCheck> {
  if (!gitPresent) {
    return {
      id: "git",
      status: "fail",
      code: "git_not_present",
      message: "git was not found on PATH",
    };
  }
  const version = await probeGitVersion();
  return {
    id: "git",
    status: "pass",
    message: version ?? "git is present",
  };
}

function bashCheck(): DoctorCheck {
  try {
    const bashPath = assertBashAvailable();
    return { id: "bash", status: "pass", message: `bash at ${bashPath}` };
  } catch (err) {
    return {
      id: "bash",
      status: "fail",
      code: "bash_not_found",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function nodeVersionCheck(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    return {
      id: "node",
      status: "pass",
      message: `Node ${process.version}`,
    };
  }
  return {
    id: "node",
    status: "warn",
    message: `Node ${process.version}; engines floor may differ from Pi/better-sqlite3 (not bumping engines.node)`,
  };
}

function discoverProviderEnvIds(env: NodeJS.ProcessEnv): string[] {
  const byLower = new Set<string>();
  for (const key of Object.keys(env)) {
    let envId: string | undefined;
    const plain = key.match(PROVIDER_KEY_RE);
    if (plain) envId = plain[1];
    else {
      const file = key.match(PROVIDER_FILE_RE);
      if (file) envId = file[1];
    }
    if (envId === undefined) continue;
    byLower.add(envId.toLowerCase().replace(/_/g, "-"));
  }
  return [...byLower].sort();
}

function credentialsCheck(cwd: string, env: NodeJS.ProcessEnv): DoctorCheck {
  const providerIds = discoverProviderEnvIds(env);
  let sourceNote = "";
  try {
    const settings = getCredentialSourceSettings(cwd);
    const source =
      settings.credentialSource ?? settings.binding.source;
    sourceNote = `; credentialSource=${source}`;
  } catch {
    /* ignore settings read failures */
  }
  if (providerIds.length === 0) {
    return {
      id: "credentials",
      status: "warn",
      message: `No STAGEFLOW_PROVIDER_*_API_KEY set${sourceNote}`,
    };
  }
  return {
    id: "credentials",
    status: "pass",
    message: `Provider credentials in env: ${providerIds.join(", ")}${sourceNote}`,
  };
}

function tlsCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const missing = warnMissingCaPaths(env);
  if (missing.length === 0) {
    const configured = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].filter(
      (name) => Boolean(env[name]?.trim()),
    );
    if (configured.length === 0) {
      return {
        id: "tls_ca_paths",
        status: "skipped",
        message: "No NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / SSL_CERT_DIR set",
      };
    }
    return {
      id: "tls_ca_paths",
      status: "pass",
      message: `CA paths exist: ${configured.join(", ")}`,
    };
  }
  return {
    id: "tls_ca_paths",
    status: "warn",
    code: "ca_path_missing",
    message: missing
      .map((w) => `${w.name}=${w.path} does not exist`)
      .join("; "),
  };
}

async function freeDiskCheck(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  try {
    const size = await readFilesystemSize(home);
    const floor = resolveMinFreeDiskFloor(
      env.STAGEFLOW_MIN_FREE_DISK_BYTES,
      size.totalBytes,
    );
    const freeGiB = (size.freeBytes / (1024 * 1024 * 1024)).toFixed(2);
    if (size.freeBytes < floor) {
      return {
        id: "free_disk",
        status: "warn",
        code: "insufficient_disk",
        message: `${home} has ${freeGiB} GiB free (below floor ${floor} bytes)`,
      };
    }
    return {
      id: "free_disk",
      status: "pass",
      message: `${home} has ${freeGiB} GiB free`,
    };
  } catch (err) {
    return {
      id: "free_disk",
      status: "warn",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function mcpCommandsCheck(cwd: string): Promise<DoctorCheck[]> {
  const mcpPath = path.join(cwd, MCP_CATALOG_FILENAME);
  try {
    accessSync(mcpPath, constants.R_OK);
  } catch {
    return [
      {
        id: "mcp_commands",
        status: "skipped",
        message: `No ${MCP_CATALOG_FILENAME} in ${cwd}`,
      },
    ];
  }
  try {
    const raw = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    const missing = findMissingMcpCommands(raw.mcpServers ?? {});
    if (missing.length === 0) {
      return [
        {
          id: "mcp_commands",
          status: "pass",
          message: "All .mcp.json commands found on PATH",
        },
      ];
    }
    return missing.map((m) => ({
      id: `mcp_command:${m.serverName}`,
      status: "warn" as const,
      code: "command_not_on_path",
      message: `MCP server "${m.serverName}" command "${m.command}" is not on PATH`,
    }));
  } catch (err) {
    return [
      {
        id: "mcp_commands",
        status: "warn",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

function preflightToDoctorChecks(
  preflight: PipelinePreflightResult,
  strict: boolean,
): DoctorCheck[] {
  return preflight.checks.map((c, i) => {
    const id =
      c.kind === "toolchain"
        ? `toolchain:${c.tool ?? i}`
        : c.kind === "secret"
          ? `secret:${c.secret ?? i}`
          : `mcp:${c.server ?? c.stageId ?? i}`;
    let status: DoctorCheckStatus = "pass";
    if (c.status === "ok") {
      status = "pass";
    } else if (c.status === "unknown_version" && !strict) {
      status = "warn";
    } else {
      status = "fail";
    }
    return {
      id,
      status,
      code: c.status === "ok" ? undefined : c.status,
      message:
        c.message ??
        (c.kind === "toolchain"
          ? `${c.tool}: ${c.status}${c.required ? ` (required ${c.required})` : ""}${c.found ? `; found ${c.found}` : ""}`
          : c.status),
    };
  });
}

export async function runDoctorChecks(options?: {
  cwd?: string;
  homeDir?: string;
  store?: RunStore;
  env?: NodeJS.ProcessEnv;
  pipeline?: string;
  strict?: boolean;
}): Promise<DoctorResult> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? globalStageflowHome();
  const env = options?.env ?? process.env;
  const strict = options?.strict === true;
  const checks: DoctorCheck[] = [];

  let store = options?.store;
  let closeStore = false;
  if (store === undefined) {
    try {
      store = createRunStore({ rootDir: home, openerMode: "migrate" });
      closeStore = true;
    } catch (err) {
      checks.push({
        id: "store_openable",
        status: "fail",
        code: "store_not_openable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (store !== undefined) {
    const readyz = await runReadyzChecks({
      store,
      homeDir: home,
      bypassCache: true,
    });
    checks.push(...mapReadyzChecks(readyz, home));
    checks.push(await gitDoctorCheck(readyz.checks.git_present));
  }

  checks.push(bashCheck());
  checks.push(nodeVersionCheck());
  checks.push(credentialsCheck(cwd, env));
  checks.push(tlsCheck(env));
  checks.push(await freeDiskCheck(home, env));
  checks.push(...(await mcpCommandsCheck(cwd)));

  let preflight: PipelinePreflightResult | undefined;
  if (options?.pipeline !== undefined) {
    const outcome = await loadPipelineOutcome(options.pipeline, { cwd });
    if (!outcome.ok) {
      checks.push({
        id: "pipeline_load",
        status: "fail",
        code: outcome.issues[0]?.code ?? "pipeline.load_error",
        message: outcome.issues[0]?.message ?? "Failed to load pipeline",
      });
    } else {
      preflight = await runPipelinePreflight(outcome.value, {
        projectRoot: cwd,
        hostEnv: env,
        strict,
      });
      checks.push(...preflightToDoctorChecks(preflight, strict));
    }
  }

  if (closeStore && store !== undefined) {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks, ...(preflight !== undefined ? { preflight } : {}) };
}

type ParsedDoctorArgs = {
  help: boolean;
  json: boolean;
  strict: boolean;
  pipeline?: string;
};

function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  let help = false;
  let json = false;
  let strict = false;
  let pipeline: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--pipeline") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --pipeline");
      }
      pipeline = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { help, json, strict, pipeline };
}

export async function runDoctorCommand(
  args: string[],
  options: {
    cwd?: string;
    io?: Partial<DoctorCommandIo>;
    runChecks?: typeof runDoctorChecks;
  } = {},
): Promise<number> {
  const out: DoctorCommandIo = { ...defaultIo, ...options.io };
  const runChecks = options.runChecks ?? runDoctorChecks;
  try {
    const parsed = parseDoctorArgs(args);
    if (parsed.help) {
      out.error(DOCTOR_USAGE);
      return 0;
    }
    const result = await runChecks({
      cwd: options.cwd,
      pipeline: parsed.pipeline,
      strict: parsed.strict,
    });
    if (parsed.json) {
      out.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        out.log(`[${check.status}] ${check.id}: ${check.message}`);
      }
      if (!result.ok) {
        out.error(
          "sf doctor reported failures. Do not use doctor as a container HEALTHCHECK; use GET /livez.",
        );
      }
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    out.error(DOCTOR_USAGE);
    return 1;
  }
}

export const DOCTOR_USAGE = `Usage:
  sf doctor [--json] [--pipeline <path>] [--strict]

Run Host preflight checks (shared /readyz store/home/migrations/git, plus bash, Node, credentials, TLS CA paths, free disk, MCP commands).
With --pipeline, also checks pipeline requires:/secrets:/mcp against the toolchain manifest and curated stage env.
--strict treats unknown_version as failure (default: warn/pass).
Do not use sf doctor as a container HEALTHCHECK — use GET /livez instead.
`;
