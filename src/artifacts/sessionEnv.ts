import { STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV } from "../config/resolveStageMcpServers.js";
import { SF_STAGE_WORKER } from "../runtime/stageWorkerProtocol.js";
import {
  STAGEFLOW_BASE_SHA,
  STAGEFLOW_CHECKOUT,
  STAGEFLOW_REF,
  STAGEFLOW_REPOSITORY,
  STAGEFLOW_RUN_BRANCH,
  STAGEFLOW_RUN_WORKSPACE,
} from "../runtime/stageRoots.js";

export const STAGEFLOW_SESSION_ENV_MARKERS = [
  "SF_WORKER_STAGEFLOW_HOME",
  STAGEFLOW_STAGE_ARTIFACTS_DIR_ENV,
  "STAGEFLOW_RUN_ID",
  "STAGEFLOW_STAGE_ID",
  STAGEFLOW_RUN_WORKSPACE,
  STAGEFLOW_CHECKOUT,
  STAGEFLOW_REPOSITORY,
  STAGEFLOW_REF,
  STAGEFLOW_BASE_SHA,
  STAGEFLOW_RUN_BRANCH,
] as const;

export function isInsideStageflowSession(env: NodeJS.ProcessEnv): boolean {
  if (env[SF_STAGE_WORKER] === "1") return true;
  for (const name of STAGEFLOW_SESSION_ENV_MARKERS) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  return false;
}
