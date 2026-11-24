import { api } from "./client";

export type ArtifactOwner =
  | { kind: "stage"; pipeline: string; stage: string }
  | { kind: "agent"; agent: string };

export type ArtifactRecord = {
  key: string;
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  kind: string;
  origin: string;
  owner: ArtifactOwner;
  source: {
    run_id: string | null;
    stage_id: string | null;
    attempt: number | null;
    session_id: string | null;
  };
  version: number;
  size_bytes: number | null;
  content_type: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  project: { id: string; registered: boolean };
};

export type ArtifactListPage = {
  artifacts: ArtifactRecord[];
  next_cursor: string | null;
};

export function fetchArtifacts(
  projectRoot?: string,
  options?: { limit?: number; cursor?: string },
): Promise<ArtifactListPage> {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  params.set("limit", String(options?.limit ?? 50));
  if (options?.cursor) params.set("cursor", options.cursor);
  const query = params.toString();
  return api(`/api/artifacts${query ? `?${query}` : ""}`);
}
