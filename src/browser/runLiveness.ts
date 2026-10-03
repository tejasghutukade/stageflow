import type { RunStatus } from "../runstore/port.js";
import type { RunLiveness } from "./profileLock.js";

/**
 * A run is live while it can still use its browser: not yet terminal. Runs
 * waiting at a gate keep status "running", so they stay live.
 */
export function createRunLiveness(source: {
  readRunMeta(runId: string): Promise<{ status?: RunStatus }>;
}): RunLiveness {
  return async (runId) => {
    try {
      const status = (await source.readRunMeta(runId)).status;
      return (
        status === undefined ||
        status === "created" ||
        status === "queued" ||
        status === "running"
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (/not found/i.test(String((err as Error)?.message))) return false;
      throw err;
    }
  };
}
