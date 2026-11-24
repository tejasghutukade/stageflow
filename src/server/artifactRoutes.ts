import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStore } from "../runstore/port.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { ArtifactQueryError, listArtifacts, parseArtifactLimit, readArtifact } from "../artifacts/query.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

function sendError(json: Json, res: ServerResponse, error: ArtifactQueryError): void {
  json(res, error.status, {
    error: error.message,
    code: error.code,
    ...(error.projectRoots !== undefined ? { project_roots: error.projectRoots } : {}),
  });
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
  const record = /^\/api\/artifacts\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!list && record === null) return false;
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
        },
        roots,
      );
      json(res, 200, page);
      return true;
    }
    const ownerKey = decodeURIComponent(record![1]!);
    const id = decodeURIComponent(record![2]!);
    const artifact = readArtifact(db, ownerKey, id, url.searchParams.get("project_root") ?? undefined, roots);
    json(res, 200, artifact);
    return true;
  } catch (error) {
    if (error instanceof URIError) {
      json(res, 400, { error: "Malformed path", code: "artifact.invalid_id" });
      return true;
    }
    if (error instanceof ArtifactQueryError) {
      sendError(json, res, error);
      return true;
    }
    throw error;
  }
}
