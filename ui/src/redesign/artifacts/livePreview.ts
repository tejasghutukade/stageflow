import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../api/artifacts";

export type LivePreviewInput = {
  format: string | null | undefined;
  library: { name?: string; version?: string } | null | undefined;
  program: string;
  bindings: ArtifactLiveBinding[];
  snapshots: ArtifactSnapshot[];
  status: string | null;
  lastRefreshedAt: string | null;
  lastErrorCode: string | null;
  settled: boolean;
  refreshing?: boolean;
  historical: boolean;
  ownerKey: string;
  artifactId: string;
  projectRoot?: string;
};
