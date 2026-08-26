import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OperatorCatalog } from "../runtime/stageAttemptBootstrap.js";

export type OperatorCatalogFlags = {
  operatorCwd?: string;
  operatorAgentDir?: string;
};

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function resolveOperatorCatalog(input: {
  flags: OperatorCatalogFlags;
  env: Record<string, string | undefined>;
  defaultCwd: string;
}): OperatorCatalog {
  const cwd =
    nonempty(input.flags.operatorCwd) ??
    nonempty(input.env.STAGEFLOW_OPERATOR_CWD) ??
    input.defaultCwd;

  const agentDir =
    nonempty(input.flags.operatorAgentDir) ??
    nonempty(input.env.STAGEFLOW_OPERATOR_AGENT_DIR) ??
    getAgentDir();

  return { cwd, agentDir };
}
