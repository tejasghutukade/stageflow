import { globalStageflowHome } from "../project/globalHome.js";
import {
  hostBaseUrl,
  probeGlobalServiceDetailed,
  type ServiceProbeResult,
} from "../server/ensureGlobalService.js";

export const HOST_USAGE = `Usage:
  sf host status [--json]

Report whether the global Stageflow host is listening on the service port and which STAGEFLOW_HOME it uses.`;

function describeProbe(probe: ServiceProbeResult): string {
  switch (probe) {
    case "up":
      return "running";
    case "starting":
      return "starting";
    case "unreachable":
      return "stopped";
    case "unhealthy":
      return "port_in_use_foreign";
    case "foreign":
      return "port_in_use_foreign";
    case "other_home":
      return "other_home";
    case "old_stageflow":
      return "old_stageflow";
    default:
      return probe;
  }
}

type ParsedHostArgs = { help: boolean; json: boolean; subcommand?: string };

function parseHostArgs(args: string[]): ParsedHostArgs {
  if (args.length === 0) return { help: false, json: false };
  if (args[0] === "--help" || args[0] === "-h") return { help: true, json: false };
  const subcommand = args[0];
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return { help: true, json };
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return { help: false, json, subcommand };
}

export type HostCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: HostCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runHostCommand(
  args: string[],
  options: { io?: Partial<HostCommandIo> } = {},
): Promise<number> {
  const out: HostCommandIo = { ...defaultIo, ...options.io };
  try {
    const parsed = parseHostArgs(args);
    if (parsed.help || !parsed.subcommand) {
      out.error(HOST_USAGE);
      return parsed.help ? 0 : 1;
    }
    if (parsed.subcommand !== "status") {
      out.error(`Unknown host subcommand: ${parsed.subcommand}`);
      out.error(HOST_USAGE);
      return 1;
    }
    const probe = await probeGlobalServiceDetailed();
    const base = hostBaseUrl();
    const home = globalStageflowHome();
    const payload = {
      url: base,
      stageflow_home: home,
      state: describeProbe(probe),
      probe,
      console_hint:
        probe === "up" || probe === "starting"
          ? `Operator console: ${base} (sf ui opens the browser when the host is already up)`
          : "Start with sf ui, or sf run will auto-start a background host",
    };
    if (parsed.json) {
      out.log(JSON.stringify(payload, null, 2));
    } else {
      out.log(`state: ${payload.state}`);
      out.log(`url: ${base}`);
      out.log(`stageflow_home: ${home}`);
      out.log(payload.console_hint);
    }
    return 0;
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    out.error(HOST_USAGE);
    return 1;
  }
}