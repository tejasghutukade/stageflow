import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ArchiveError, buildArchive } from "../archive/build.js";
import { BackupError, resolveBackupDownloadPath } from "../runstore/backup.js";
import type { RunStore } from "../runstore/port.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export type ArchiveAudit = (outcome: "ok" | "error", errorCode?: string) => void;

let building = false;

/** Test hook: lets a test hold the single build slot. */
export function holdArchiveSlotForTests(held: boolean): void {
  building = held;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > 65536) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/**
 * `POST /api/archive` builds an archive under $STAGEFLOW_HOME/backups/ (the caller cannot pick the path) and answers with
 * its name, size and counts, never the path or any content. `GET /api/archive/<name>` streams one. Both need drive scope
 * (see requiredScopeFor), because an archive can hold secrets.
 */
export async function handleArchiveRoutes(
  req: IncomingMessage, method: string, pathname: string, deps: { store: RunStore; homeDir: string; audit: ArchiveAudit }, res: ServerResponse, json: Json,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/archive") {
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { code: "archive_bad_request", error: "Request body must be a small JSON object" });
      return true;
    }
    if (building) {
      json(res, 409, { code: "archive_in_progress", error: "An archive is already being built" });
      return true;
    }
    building = true;
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
      building = false;
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
