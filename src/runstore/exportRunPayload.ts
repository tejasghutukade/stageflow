import { projectRun, type RunProjection } from "../projection/projectRun.js";
import type { RunDetail } from "./port.js";
import {
  redactRunManifestForRead,
  type RunManifest,
} from "./runManifest.js";
import { getNamedSecrets } from "../logging/namedSecrets.js";

export type RunExportPayload = RunProjection & {
  run_manifest: RunManifest | null;
};

export function buildRunExportPayload(detail: RunDetail): RunExportPayload {
  return {
    ...projectRun(detail),
    run_manifest: redactRunManifestForRead(detail.run_manifest, {
      namedSecrets: getNamedSecrets(),
    }),
  };
}

export function runDetailWithRedactedManifest(detail: RunDetail): RunDetail {
  const run_manifest = redactRunManifestForRead(detail.run_manifest, {
    namedSecrets: getNamedSecrets(),
  });
  if (run_manifest === null) {
    if (detail.run_manifest === undefined) return detail;
    const { run_manifest: _drop, ...rest } = detail;
    return rest;
  }
  return { ...detail, run_manifest };
}
