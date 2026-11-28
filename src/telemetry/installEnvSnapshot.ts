import { captureTelemetryEnvSnapshot } from "./envSnapshot.js";

// Imported before telemetryEnv so this freezes the operator's values
// before startup forces DO_NOT_TRACK=1 for third-party library opt-out.
captureTelemetryEnvSnapshot();
