import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStore } from "../runstore/port.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { ArtifactContentError, readArtifactContent } from "../artifacts/content.js";
import { ArtifactQueryError, listArtifacts, parseArtifactLimit, parseArtifactStatus, readArtifact } from "../artifacts/query.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

function sendError(
  json: Json,
  res: ServerResponse,
  error: ArtifactQueryError | ArtifactContentError,
): void {
  const projectRoots = error instanceof ArtifactQueryError ? error.projectRoots : undefined;
  json(res, error.status, {
    error: error.message,
    code: error.code,
    ...(projectRoots !== undefined ? { project_roots: projectRoots } : {}),
  });
}

function sendContent(res: ServerResponse, bytes: Buffer, contentType: string, contentHash: string | null): void {
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": bytes.length,
    "X-Content-Type-Options": "nosniff",
  };
  if (contentHash) headers["X-Artifact-Content-Hash"] = contentHash;
  res.writeHead(200, headers);
  res.end(bytes);
}

export async function handleArtifactRoutes(
  _req: IncomingMessage,
  method: string,
  pathname: string,
  url: URL,
  store: RunStore,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const list = pathname === "/api/artifacts";
  const content = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/content$/.exec(pathname);
  const record = /^\/api\/artifacts\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!list && content === null && record === null) return false;
  if (method !== "GET") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  const db = sqliteConnectionFromStore(store);
  if (db === undefined) {
    json(res, 503, { error: "Artifact index is unavailable", code: "artifact.store_unavailable" });
    return true;
  }
  try {
    const roots = await catalogRootsForArtifacts(store);
    if (list) {
      const page = listArtifacts(
        db,
        {
          projectRoot: url.searchParams.get("project_root") ?? undefined,
          limit: parseArtifactLimit(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor") ?? undefined,
          status: parseArtifactStatus(url.searchParams.get("status")),
        },
        roots,
      );
      json(res, 200, page);
      return true;
    }
    const match = content ?? record;
    const ownerKey = decodeURIComponent(match![1]!);
    const id = decodeURIComponent(match![2]!);
    const projectRoot = url.searchParams.get("project_root") ?? undefined;
    if (content) {
      const body = await readArtifactContent(db, store, ownerKey, id, projectRoot, roots);
      sendContent(res, body.bytes, body.contentType, body.contentHash);
      return true;
    }
    const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
    json(res, 200, artifact);
    return true;
  } catch (error) {
    if (error instanceof URIError) {
      json(res, 400, { error: "Malformed path", code: "artifact.invalid_id" });
      return true;
    }
    if (error instanceof ArtifactQueryError || error instanceof ArtifactContentError) {
      sendError(json, res, error);
      return true;
    }
    throw error;
  }
}
