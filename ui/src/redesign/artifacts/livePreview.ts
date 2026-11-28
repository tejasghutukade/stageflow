import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../api/artifacts";
import type { LiveQuery } from "./liveData/liveQuery";

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
  /** Chat uses the session action bridge. The artifacts page keeps the artifact query route. */
  query?: LiveQuery;
};
