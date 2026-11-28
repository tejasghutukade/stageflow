import { readStageflowHomeId } from "../diagnostics/checks.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { hostBaseUrl, probeStageflowHost } from "../server/ensureGlobalService.js";

export const HOST_HOME_WARNING_OPT_OUT_ENV = "STAGEFLOW_NO_HOST_HOME_WARNING";

const WARNED_COMMANDS = new Set(["run", "runs", "artifact"]);

export function hostHomeMismatchMessage(input: {
  baseUrl: string;
  hostHomeId: string | undefined;
  localHome: string;
  localHomeId: string | undefined;
}): string {
  return [
    `Warning: a Stageflow Host is running at ${input.baseUrl} with a different data directory than this command.`,
    `  Host home id:  ${input.hostHomeId ?? "unknown"}`,
    `  This process:  ${input.localHomeId ?? "no home id yet"} (${input.localHome})`,
    "Runs, pipelines and artifacts created here will not appear in that Host's console.",
    "To reach the Host's data, run the command inside its container (docker exec <container> sf ...), or use the Host's MCP endpoint.",
    `Set ${HOST_HOME_WARNING_OPT_OUT_ENV}=1 to silence this warning.`,
  ].join("\n");
}

async function readHostHomeId(baseUrl: string): Promise<string | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/livez`, { signal: ac.signal });
    const body = JSON.parse(await res.text()) as { home_id?: unknown };
    return typeof body.home_id === "string" ? body.home_id : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Writes to stderr only, never throws, and never blocks when no Host answers. */
export async function warnIfHostUsesOtherHome(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (command === undefined || !WARNED_COMMANDS.has(command)) return;
  const optOut = env[HOST_HOME_WARNING_OPT_OUT_ENV];
  if (optOut !== undefined && optOut !== "" && optOut !== "0") return;
  try {
    const baseUrl = hostBaseUrl();
    const probed = await probeStageflowHost(baseUrl, { expectedHomeId: () => readStageflowHomeId() });
    if (probed !== "other_home") return;
    const hostHomeId = await readHostHomeId(baseUrl);
    console.error(
      hostHomeMismatchMessage({
        baseUrl,
        hostHomeId,
        localHome: globalStageflowHome(),
        localHomeId: readStageflowHomeId(),
      }),
    );
  } catch {
    // The warning is advisory.
  }
}
