export const UNLIMITED_CONCURRENCY = Number.POSITIVE_INFINITY;

export const DEFAULT_MAX_ACTIVE_STAGES_PER_RUN = UNLIMITED_CONCURRENCY;

export const MAX_ACTIVE_STAGES_PER_RUN_ENV =
  "STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN";

export const DEFAULT_MAX_ACTIVE_STAGE_PROCESSES = UNLIMITED_CONCURRENCY;

export const MAX_ACTIVE_STAGE_PROCESSES_ENV =
  "STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES";

export const STAGE_EXECUTION_ENV = "STAGEFLOW_STAGE_EXECUTION";

export type StageExecutionMode = "process" | "inprocess";

export function readStageExecutionMode(
  env: Record<string, string | undefined> = process.env,
  override?: StageExecutionMode,
): StageExecutionMode {
  if (override !== undefined) {
    return override;
  }
  if (env.VITEST === "true") {
    return "inprocess";
  }
  const raw = env[STAGE_EXECUTION_ENV];
  if (raw === "inprocess" || raw === "process") {
    return raw;
  }
  return "process";
}

export function readMaxActiveStagesPerRun(
  env: Record<string, string | undefined> = process.env,
  override?: number,
): number {
  if (override !== undefined) {
    if (Number.isFinite(override) && override >= 1) return override;
    return DEFAULT_MAX_ACTIVE_STAGES_PER_RUN;
  }
  const raw = env[MAX_ACTIVE_STAGES_PER_RUN_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_ACTIVE_STAGES_PER_RUN;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_MAX_ACTIVE_STAGES_PER_RUN;
  }
  return n;
}

export function readMaxActiveStageProcesses(
  env: Record<string, string | undefined> = process.env,
  override?: number,
): number {
  if (override !== undefined) {
    if (Number.isFinite(override) && override >= 1) return override;
    return DEFAULT_MAX_ACTIVE_STAGE_PROCESSES;
  }
  const raw = env[MAX_ACTIVE_STAGE_PROCESSES_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_ACTIVE_STAGE_PROCESSES;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_MAX_ACTIVE_STAGE_PROCESSES;
  }
  return n;
}
