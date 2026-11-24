import { api } from "./client";
import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

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
  status: "available" | "expired";
  expired_at: string | null;
  expired_reason: string | null;
  content_hash?: string | null;
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

export class ArtifactRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "ArtifactRequestError";
    this.status = status;
    this.code = code;
  }
}

function artifactRecordPath(ownerKey: string, id: string, projectRoot?: string): string {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  const query = params.toString();
  const path = `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}`;
  return query ? `${path}?${query}` : path;
}

export function artifactContentPath(ownerKey: string, id: string, projectRoot?: string): string {
  const params = new URLSearchParams();
  if (projectRoot) params.set("project_root", projectRoot);
  const query = params.toString();
  const path = `/api/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}/content`;
  return query ? `${path}?${query}` : path;
}

async function readArtifactError(res: Response): Promise<ArtifactRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 401) notifyControlTokenRequired();
  return new ArtifactRequestError(res.status, body.code, body.error ?? `Request failed (${res.status})`);
}

export function fetchArtifact(ownerKey: string, id: string, projectRoot?: string): Promise<ArtifactRecord> {
  return api(artifactRecordPath(ownerKey, id, projectRoot));
}

export type ArtifactContentPayload =
  | { kind: "text"; text: string; contentType: string; contentHash: string | null; size: number }
  | { kind: "image"; objectUrl: string; contentType: string; contentHash: string | null; size: number }
  | { kind: "binary"; contentType: string; contentHash: string | null; size: number };

export async function fetchArtifactContent(
  ownerKey: string,
  id: string,
  projectRoot?: string,
): Promise<ArtifactContentPayload> {
  const res = await fetch(artifactContentPath(ownerKey, id, projectRoot), {
    headers: { ...authorizationHeaders() },
  });
  if (!res.ok) throw await readArtifactError(res);
  const contentType = res.headers.get("content-type") ?? "";
  const contentHash = res.headers.get("x-artifact-content-hash");
  if (contentType.startsWith("image/")) {
    const blob = await res.blob();
    return {
      kind: "image",
      objectUrl: URL.createObjectURL(blob),
      contentType,
      contentHash,
      size: blob.size,
    };
  }
  if (contentType.startsWith("application/octet-stream")) {
    const blob = await res.blob();
    return { kind: "binary", contentType, contentHash, size: blob.size };
  }
  const text = await res.text();
  return {
    kind: "text",
    text,
    contentType,
    contentHash,
    size: new TextEncoder().encode(text).length,
  };
}
