const OPT_OUT = "OPENUI_TELEMETRY_DISABLED";

/** Throws before `@openuidev/lang-core` is loaded when the install/runtime opt-out is missing. */
export function assertOpenUiTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[OPT_OUT] !== "1") {
    throw new Error(
      "Refusing to load @openuidev/lang-core: OPENUI_TELEMETRY_DISABLED=1 is required. Stageflow forces this opt-out and does not enable OpenUI telemetry.",
    );
  }
}
