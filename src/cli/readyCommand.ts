import { getAuthStatus } from "../agent/providerAuth.js";
import { loadPipelineOutcome } from "../config/loadPipeline.js";
import {
  findingsForModelPlaceholders,
  isModelPlaceholder,
  modelPlaceholderFixHint,
  providerIdFromModel,
} from "../config/modelPlaceholder.js";
import {
  hostBaseUrl,
  probeGlobalServiceDetailed,
  type ServiceProbeResult,
} from "../server/ensureGlobalService.js";
import { globalStageflowHome } from "../project/globalHome.js";

export type ReadyCheckStatus = "pass" | "fail" | "warn";

export type ReadyCheck = {
  id: string;
  status: ReadyCheckStatus;
  message: string;
  fix?: string;
};

export type ReadyResult = { ok: boolean; checks: ReadyCheck[] };

export const READY_USAGE = `Usage:
  sf ready [--json] [--pipeline <path>]

Checks whether this machine and catalog are ready to run a pipeline: Node version, global home, host reachability, provider auth, and (with --pipeline) resolved models without CHANGE_ME placeholders.
Exit 0 when all checks pass, 1 otherwise.`;

type ParsedReadyArgs = { help: boolean; json: boolean; pipeline?: string };

function parseReadyArgs(args: string[]): ParsedReadyArgs {
  let help = false;
  let json = false;
  let pipeline: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--pipeline") {
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
  return { help, json, pipeline };
}

function hostStatusLabel(probe: ServiceProbeResult): ReadyCheck {
  const base = hostBaseUrl();
  if (probe === "up" || probe === "starting") {
    return {
      id: "host",
      status: "pass",
      message:
        probe === "up"
          ? `Stageflow host is reachable at ${base}`
          : `Stageflow host is starting at ${base}`,
    };
  }
  return {
    id: "host",
    status: "warn",
    message: `No Stageflow host at ${base} yet (sf run will start one, or run sf ui first)`,
    fix: "sf ui",
  };
}

async function configuredProviderIds(cwd: string): Promise<string[]> {
  try {
    const status = await getAuthStatus(cwd);
    const rows = Array.isArray(status) ? status : [status];
    return rows.filter((r) => r.configured).map((r) => r.providerId);
  } catch {
    return [];
  }
}

export async function runReadyChecks(options: {
  cwd?: string;
  pipeline?: string;
}): Promise<ReadyResult> {
  const cwd = options.cwd ?? process.cwd();
  const checks: ReadyCheck[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 20
      ? { id: "node", status: "pass", message: `Node ${process.version}` }
      : {
          id: "node",
          status: "fail",
          message: `Node ${process.version} is below the required major version 20`,
        },
  );

  const home = globalStageflowHome();
  checks.push({
    id: "stageflow_home",
    status: "pass",
    message: `STAGEFLOW_HOME ${home}`,
  });

  const probe = await probeGlobalServiceDetailed();
  checks.push(hostStatusLabel(probe));

  const configured = await configuredProviderIds(cwd);
  if (configured.length === 0) {
    checks.push({
      id: "provider",
      status: "fail",
      message: "No model provider is connected",
      fix: "sf providers list && sf providers login <id> --type api_key",
    });
  } else {
    checks.push({
      id: "provider",
      status: "pass",
      message: `Configured provider(s): ${configured.join(", ")}`,
    });
  }

  if (options.pipeline !== undefined) {
    const outcome = await loadPipelineOutcome(options.pipeline, { cwd });
    if (!outcome.ok) {
      checks.push({
        id: "pipeline_load",
        status: "fail",
        message: outcome.issues[0]?.message ?? "Failed to load pipeline",
      });
    } else {
      const placeholders = findingsForModelPlaceholders(
        cwd,
        options.pipeline,
        outcome.value,
      );
      if (placeholders.length > 0) {
        checks.push({
          id: "model_placeholder",
          status: "fail",
          message: placeholders[0]!.message,
          fix: "sf init --fix-model",
        });
      } else {
        for (const stage of outcome.value.stages) {
          const model =
            stage.model ?? outcome.value.pipeline.model;
          if (model === undefined || isModelPlaceholder(model)) continue;
          const providerId = providerIdFromModel(model);
          if (providerId === undefined) continue;
          if (!configured.some((id) => id.toLowerCase() === providerId)) {
            checks.push({
              id: "model_provider",
              status: "fail",
              message: `Stage "${stage.id}" uses ${model} but provider "${providerId}" is not connected`,
              fix: `sf providers login ${providerId} --type api_key`,
            });
            break;
          }
        }
        if (!checks.some((c) => c.id === "model_provider")) {
          checks.push({
            id: "pipeline_models",
            status: "pass",
            message: `Pipeline "${outcome.value.pipeline.id}" has no CHANGE_ME placeholders`,
          });
        }
      }
    }
  } else if (configured.length === 0) {
    checks.push({
      id: "hint",
      status: "warn",
      message: modelPlaceholderFixHint(),
    });
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

/** Subset used by `sf run` before start_run: model placeholders and provider/model mismatches only. */
export async function runRunPreflight(options: {
  cwd?: string;
  pipeline: string;
}): Promise<ReadyResult> {
  const full = await runReadyChecks(options);
  const runIds = new Set(["model_placeholder", "model_provider", "pipeline_load"]);
  const checks = full.checks.filter((c) => runIds.has(c.id));
  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks: checks.length > 0 ? checks : full.checks.filter((c) => c.id === "pipeline_models") };
}

export type ReadyCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: ReadyCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runReadyCommand(
  args: string[],
  options: { cwd?: string; io?: Partial<ReadyCommandIo> } = {},
): Promise<number> {
  const out: ReadyCommandIo = { ...defaultIo, ...options.io };
  try {
    const parsed = parseReadyArgs(args);
    if (parsed.help) {
      out.error(READY_USAGE);
      return 0;
    }
    const result = await runReadyChecks({
      cwd: options.cwd,
      pipeline: parsed.pipeline,
    });
    if (parsed.json) {
      out.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        out.log(`[${check.status}] ${check.id}: ${check.message}`);
        if (check.fix !== undefined) out.log(`  fix: ${check.fix}`);
      }
      if (!result.ok) {
        out.error("Not ready to run. Fix the failures above, or run sf ready --pipeline <path> after sf init.");
      }
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    out.error(READY_USAGE);
    return 1;
  }
}