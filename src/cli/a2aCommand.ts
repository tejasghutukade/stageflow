import path from "node:path";
import { loadPublicationRegistry } from "../a2a/registry.js";

export const A2A_USAGE = `sf a2a validate --config <path>
sf a2a list --config <path>

Validate or inspect an A2A publication configuration. Discovery preview only;
pipeline execution through A2A is not yet enabled. Credentials are read from
the environment variables named in the configuration.`;

export async function runA2aCommand(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void; error?: (line: string) => void },
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  if (args[0] === "--help" || args[0] === "-h") { log(A2A_USAGE); return 0; }
  if (!["validate", "list"].includes(args[0]) || args[1] !== "--config" || !args[2] || args.length !== 3) {
    error(A2A_USAGE);
    return 1;
  }
  try {
    const registry = await loadPublicationRegistry(path.resolve(options.cwd, args[2]), options.env);
    log(JSON.stringify({ ok: true, configPath: registry.configPath, publicUrl: registry.publicUrl, mode: "discovery", publications: registry.summaries() }));
    if (args[0] === "list") {
      log("Configuration validated locally. Set STAGEFLOW_A2A_CONFIG before starting the host; an already-running host must be restarted explicitly.");
    }
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
