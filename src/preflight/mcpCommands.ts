import { accessSync, constants } from "node:fs";
import path from "node:path";

export type McpCommandMissing = {
  command: string;
  serverName: string;
};

export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

export function findMissingMcpCommands(
  servers: Record<string, { command?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): McpCommandMissing[] {
  const missing: McpCommandMissing[] = [];
  for (const [serverName, server] of Object.entries(servers)) {
    if (!server.command) continue;
    if (resolveCommandOnPath(server.command, env) === undefined) {
      missing.push({ command: server.command, serverName });
    }
  }
  return missing;
}
