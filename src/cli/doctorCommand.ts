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
      status: "fail" as const,
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

export async function runDoctorChecks(options?: {
  cwd?: string;
  homeDir?: string;
  store?: RunStore;
  env?: NodeJS.ProcessEnv;
}): Promise<DoctorResult> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? globalStageflowHome();
  const env = options?.env ?? process.env;
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

  if (closeStore && store !== undefined) {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

export const DOCTOR_USAGE = `Usage:
  sf doctor [--json]

Run Host preflight checks (shared /readyz store/home/migrations/git, plus bash, Node, credentials, TLS CA paths, free disk, MCP commands).
Do not use sf doctor as a container HEALTHCHECK — use GET /livez instead.
`;
