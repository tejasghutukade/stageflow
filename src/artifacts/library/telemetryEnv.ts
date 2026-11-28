/** Force the OpenUI opt-out. Does not load `@openuidev/lang-core`. */
export function applyOpenUiTelemetryEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.OPENUI_TELEMETRY_DISABLED = "1";
  env.DO_NOT_TRACK = "1";
  delete env.OPENUI_RUNTIME_TELEMETRY_ENABLED;
}

applyOpenUiTelemetryEnv();
