import { accessSync, constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { globalStageflowHome } from "../project/globalHome.js";
import { findMissingMcpCommands } from "../preflight/mcpCommands.js";
import { assertBashAvailable } from "../preflight/bash.js";
import { MCP_CATALOG_FILENAME } from "../config/resolveStageMcpServers.js";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

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

function homeWritableCheck(home: string): DoctorCheck {
  try {
    accessSync(home, constants.W_OK);
    return { id: "home_writable", status: "pass", message: `${home} is writable` };
  } catch {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    return {
      id: "home_writable",
      status: "fail",
      code: "home_not_writable",
      message: `STAGEFLOW_HOME is not writable (${home}). Running as uid=${uid} gid=${gid}. Try: sudo chown -R ${uid}:${gid} ${home}`,
    };
  }
}

async function gitCheck(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    return { id: "git", status: "pass", message: stdout.trim() };
  } catch {
    return {
      id: "git",
      status: "fail",
      code: "command_not_on_path",
      message: "git was not found on PATH",
    };
  }
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
}): Promise<DoctorResult> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? globalStageflowHome();
  const checks: DoctorCheck[] = [];
  checks.push(await gitCheck());
  checks.push(bashCheck());
  checks.push(nodeVersionCheck());
  checks.push(homeWritableCheck(home));
  checks.push(...(await mcpCommandsCheck(cwd)));
  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

export const DOCTOR_USAGE = `Usage:
  sf doctor [--json]

Run Host preflight checks (git, bash, Node, STAGEFLOW_HOME, MCP commands).
Do not use sf doctor as a container HEALTHCHECK — use GET /livez instead.
`;
