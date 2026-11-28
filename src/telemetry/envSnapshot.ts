/**
 * Process env values that decide Telemetry consent, frozen before startup
 * forces `DO_NOT_TRACK=1` for third-party library opt-out.
 * Consent code reads this snapshot and never `process.env` for these keys.
 */
export type TelemetryEnvSnapshot = Readonly<{
  doNotTrack: string | undefined;
  stageflowTelemetry: string | undefined;
  ci: string | undefined;
}>;

let captured: TelemetryEnvSnapshot | undefined;

function readRaw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function freezeSnapshot(
  doNotTrack: string | undefined,
  stageflowTelemetry: string | undefined,
  ci: string | undefined,
): TelemetryEnvSnapshot {
  return Object.freeze({ doNotTrack, stageflowTelemetry, ci });
}

/** First call wins. Later calls return the same snapshot. */
export function captureTelemetryEnvSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryEnvSnapshot {
  if (captured) return captured;
  captured = freezeSnapshot(
    readRaw(env, "DO_NOT_TRACK"),
    readRaw(env, "STAGEFLOW_TELEMETRY"),
    readRaw(env, "CI"),
  );
  return captured;
}

/** The startup snapshot, capturing now only if nothing captured yet. */
export function readTelemetryEnvSnapshot(): TelemetryEnvSnapshot {
  return captured ?? captureTelemetryEnvSnapshot();
}

/** Replaces the snapshot. Missing fields are unset. */
export function setTelemetryEnvSnapshotForTests(snapshot: {
  doNotTrack?: string;
  stageflowTelemetry?: string;
  ci?: string;
}): void {
  captured = freezeSnapshot(
    snapshot.doNotTrack,
    snapshot.stageflowTelemetry,
    snapshot.ci,
  );
}

export function resetTelemetryEnvSnapshotForTests(): void {
  captured = undefined;
}
