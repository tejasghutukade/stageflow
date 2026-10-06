import type { LoadedPipeline } from "../types/pipeline.js";
import {
  collectEffectiveRequires,
  type ToolRequirement,
} from "../config/toolRequires.js";
import {
  resolveStageMcpServers,
  StageMcpError,
} from "../config/resolveStageMcpServers.js";
import {
  assertSecretPresent,
  loadSecretRegistry,
  SecretUnavailableError,
} from "../runtime/stageSecrets.js";
import { isForeverDeniedSecret } from "../runtime/stageEnvironment.js";
import {
  checkToolchainRequirements,
  curatedStageEnv,
  type CheckToolchainOptions,
  type ToolchainCheck,
  type ToolchainCheckResult,
} from "./toolchain.js";

export type PreflightCheckKind =
  | "toolchain"
  | "secret"
  | "mcp";

export type PreflightItem = {
  kind: PreflightCheckKind;
  status:
    | "ok"
    | "missing_tool"
    | "tool_version_mismatch"
    | "unknown_version"
    | "secret_unavailable"
    | "stage.unknown_secret"
    | "stage.denied_secret"
    | "unresolved_var"
    | "missing_catalog"
    | "unknown_server"
    | "invalid_config"
    | "untrusted_config_origin";
  tool?: string;
  required?: string;
  found?: string;
  path?: string;
  secret?: string;
  stageId?: string;
  server?: string;
  message?: string;
};

export type PipelinePreflightResult = {
  ok: boolean;
  checks: PreflightItem[];
  requirements: ToolRequirement[];
  toolchain: ToolchainCheckResult;
};

function toolchainItems(checks: ToolchainCheck[]): PreflightItem[] {
  return checks.map((c) => ({
    kind: "toolchain" as const,
    status: c.status,
    tool: c.tool,
    required: c.required,
    found: c.found,
    path: c.path,
  }));
}

export function checkStageSecretsPresence(
  loaded: LoadedPipeline,
  hostEnv: NodeJS.ProcessEnv = process.env,
): PreflightItem[] {
  const registry = loadSecretRegistry(hostEnv);
  const items: PreflightItem[] = [];
  for (const stage of loaded.stages) {
    for (const decl of stage.secrets ?? []) {
      if (isForeverDeniedSecret(decl.name)) {
        items.push({
          kind: "secret",
          status: "stage.denied_secret",
          secret: decl.name,
          stageId: stage.id,
          message: `secret "${decl.name}" is permanently denied`,
        });
        continue;
      }
      try {
        assertSecretPresent(decl.name, registry, hostEnv);
        items.push({
          kind: "secret",
          status: "ok",
          secret: decl.name,
          stageId: stage.id,
        });
      } catch (err) {
        if (err instanceof SecretUnavailableError) {
          items.push({
            kind: "secret",
            status: "secret_unavailable",
            secret: decl.name,
            stageId: stage.id,
            message: err.message,
          });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("stage.unknown_secret")) {
          items.push({
            kind: "secret",
            status: "stage.unknown_secret",
            secret: decl.name,
            stageId: stage.id,
            message: `unknown secret "${decl.name}" is not in the Host secret registry`,
          });
          continue;
        }
        items.push({
          kind: "secret",
          status: "secret_unavailable",
          secret: decl.name,
          stageId: stage.id,
          message,
        });
      }
    }
  }
  return items;
}

export async function checkStageMcpResolution(
  loaded: LoadedPipeline,
  options: {
    projectRoot: string;
    hostEnv?: NodeJS.ProcessEnv;
  },
): Promise<PreflightItem[]> {
  const hostEnv = options.hostEnv ?? process.env;
  const stageEnv: NodeJS.ProcessEnv = { ...curatedStageEnv(hostEnv) };
  const registry = loadSecretRegistry(hostEnv);

  for (const stage of loaded.stages) {
    for (const decl of stage.secrets ?? []) {
      try {
        assertSecretPresent(decl.name, registry, hostEnv);
        const entry = registry.get(decl.name);
        if (entry?.kind === "env") {
          const plain = hostEnv[decl.name];
          const fileKey = `${decl.name}_FILE`;
          const filePath = hostEnv[fileKey];
          if (plain !== undefined && plain.length > 0) {
            stageEnv[decl.name] = plain;
          } else if (filePath !== undefined && filePath.length > 0) {
            try {
              const { readFileSync } = await import("node:fs");
              stageEnv[decl.name] = readFileSync(filePath, "utf8").replace(
                /\r?\n$/,
                "",
              );
            } catch {
              /* presence already checked */
            }
          }
        }
      } catch {
        /* secret presence reported separately */
      }
    }
  }

  const items: PreflightItem[] = [];

  for (const stage of loaded.stages) {
    const allowlist = stage.mcp ?? [];
    if (allowlist.length === 0) continue;
    try {
      await resolveStageMcpServers({
        projectRoot: options.projectRoot,
        allowlist,
        env: stageEnv,
        stageId: stage.id,
      });
      for (const server of allowlist) {
        items.push({
          kind: "mcp",
          status: "ok",
          server,
          stageId: stage.id,
        });
      }
    } catch (err) {
      if (err instanceof StageMcpError) {
        items.push({
          kind: "mcp",
          status: err.code as PreflightItem["status"],
          stageId: stage.id,
          message: err.message,
        });
        continue;
      }
      items.push({
        kind: "mcp",
        status: "invalid_config",
        stageId: stage.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return items;
}

export async function runPipelinePreflight(
  loaded: LoadedPipeline,
  options: {
    projectRoot: string;
    hostEnv?: NodeJS.ProcessEnv;
    toolchain?: CheckToolchainOptions;
    /** When true (doctor --strict / explicit), unknown_version fails. */
    strict?: boolean;
    /** start_run: unknown_version passes; missing/mismatch fail. */
    forStart?: boolean;
  },
): Promise<PipelinePreflightResult> {
  const hostEnv = options.hostEnv ?? process.env;
  const strict = options.strict === true;
  const forStart = options.forStart === true;

  const reqOutcome = collectEffectiveRequires({
    pipelineRequires: loaded.pipeline.requires,
    stageRequires: loaded.stages.map((s) => s.requires),
    pipelineId: loaded.pipeline.id,
  });
  const requirements = reqOutcome.ok ? reqOutcome.value : [];

  const toolchain = checkToolchainRequirements(requirements, {
    ...options.toolchain,
    env: hostEnv,
    strict: forStart ? false : strict,
    failOnUnknownVersion: forStart ? false : strict,
  });

  const secretChecks = checkStageSecretsPresence(loaded, hostEnv);
  const mcpChecks = await checkStageMcpResolution(loaded, {
    projectRoot: options.projectRoot,
    hostEnv,
  });

  const checks: PreflightItem[] = [
    ...toolchainItems(toolchain.checks),
    ...secretChecks,
    ...mcpChecks,
  ];

  const ok =
    toolchain.ok &&
    !secretChecks.some((c) => c.status !== "ok") &&
    !mcpChecks.some((c) => c.status !== "ok");

  return { ok, checks, requirements, toolchain };
}

export function preflightFailureCode(
  result: PipelinePreflightResult,
  options: { strict?: boolean; forStart?: boolean } = {},
): string | undefined {
  for (const check of result.checks) {
    if (check.status === "ok") continue;
    if (check.status === "unknown_version") {
      if (options.forStart) continue;
      if (!options.strict) continue;
      return "unknown_version";
    }
    return check.status;
  }
  return undefined;
}
