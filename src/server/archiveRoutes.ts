import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ArchiveError, buildArchive } from "../archive/build.js";
import { readJsonBody } from "../agents/ndjson.js";
import { BackupError, resolveBackupDownloadPath } from "../runstore/backup.js";
import type { RunStore } from "../runstore/port.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 65536;

export type ArchiveAudit = (outcome: "ok" | "error", errorCode?: string) => void;

/** One archive is built at a time per Host. A server owns one slot; a test can hand in its own and hold it. */
export type ArchiveSlot = { busy: boolean };
export function createArchiveSlot(): ArchiveSlot {
  return { busy: false };
}

/**
 * `POST /api/archive` builds an archive under $STAGEFLOW_HOME/backups/ (the caller cannot pick the path) and answers with
 * its name, size and counts, never the path or any content. `GET /api/archive/<name>` streams one. Both need drive scope
 * (see requiredScopeFor), because an archive can hold secrets.
 */
export async function handleArchiveRoutes(
  req: IncomingMessage, method: string, pathname: string, deps: { store: RunStore; homeDir: string; audit: ArchiveAudit; slot: ArchiveSlot }, res: ServerResponse, json: Json,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/archive") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch {
      json(res, 400, { code: "archive_bad_request", error: "Request body must be a small JSON object" });
      return true;
    }
    if (deps.slot.busy) {
      json(res, 409, { code: "archive_in_progress", error: "An archive is already being built" });
      return true;
    }
    deps.slot.busy = true;
    try {
      const result = await buildArchive({
        store: deps.store,
        homeDir: deps.homeDir,
        includeSecrets: body.include_secrets === true,
        includeA2aArtifacts: body.include_a2a_artifacts === true,
      });
      deps.audit("ok");
      const { path: file, ...rest } = result;
      json(res, 200, { name: path.basename(file), ...rest });
    } catch (err) {
      if (err instanceof ArchiveError || err instanceof BackupError) {
        deps.audit("error", err.code);
        json(res, err.code === "archive_insufficient_space" ? 507 : 400, { code: err.code, error: err.message });
        return true;
      }
      throw err;
    } finally {
      deps.slot.busy = false;
    }
    return true;
  }

  const match = pathname.match(/^\/api\/archive\/([^/]+)$/);
  if (method === "GET" && match) {
    const name = decodeURIComponent(match[1] ?? "");
    try {
      const file = await resolveBackupDownloadPath(name, deps.homeDir);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": statSync(file).size,
        "Content-Disposition": `attachment; filename="${path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      });
      createReadStream(file).pipe(res);
    } catch (err) {
      if (err instanceof BackupError) {
        json(res, 400, { code: err.code, error: err.message });
        return true;
      }
      throw err;
    }
    return true;
  }
  return false;
}
