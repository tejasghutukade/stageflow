import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, access } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentPort } from "../agent/port.js";
import {
  getCredentialSourceSettings,
  setCredentialSource,
  type ProviderAuthContext,
} from "../agent/providerAuth.js";
import { mapProviderAuthError } from "../agent/providerInspect.js";
import { handleProviderRoutes } from "./providerRoutes.js";
import { handleProjectMcpRoutes } from "./projectMcpRoutes.js";
import { createPipeline, parseCreatePipelineBody } from "../config/createPipeline.js";
import { createStage, parseCreateStageBody } from "../config/createStage.js";
import {
  createDraftPackage,
  loadDraftPackage,
  loadTaskArtifact,
  overwriteDraftPackage,
  parseAttachTaskBody,
  parseCreateDraftPackageBody,
  parseDraftPackageBody,
  parseOpenDraftPackageBody,
  parseOverwriteDraftPackageBody,
  validateDraftPackage,
} from "../config/draftPackage.js";
import {
  clearWorkshopAutosave,
  detectDiskChange,
  draftPackageDiskRelativePaths,
  fingerprintPackageFiles,
  parseWorkshopAutosaveRecord,
  readWorkshopAutosave,
  resolveWorkshopAutosaveStoreRoot,
  workshopAutosaveSlotKey,
  writeWorkshopAutosave,
  type WorkshopAutosaveRecord,
} from "../workshop/autosave.js";
import {
  acceptWorkshopSessionMutation,
  iterateWorkshopChatStreamFrames,
  runWorkshopChatTurn,
  undoWorkshopSessionMutation,
  WorkshopChatSessionRegistry,
  WorkshopSessionStoreError,
} from "../workshop/chatTurn.js";
import { resolveWorkshopModel } from "../workshop/modelSettings.js";
import {
  createWorkshopSession,
  getWorkshopSession,
  listWorkshopSessions,
  resolveWorkshopSessionStoreRoot,
} from "../workshop/sessionStore.js";
import {
  createLiveWorkshopOperatorHost,
  type OperatorAgentHost,
} from "../operatorAgent/index.js";
import { browseCatalog } from "../config/browseCatalog.js";
import {
  listModelsMultiProject,
  listPipelinesMultiProject,
  listTasksMultiProject,
} from "../config/multiProjectCatalog.js";
import {
  catalogPathErrorBody,
  CatalogPathError,
  resolveCatalogRelativePath,
  resolveCatalogStartInput,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { listExtensions } from "../config/listExtensions.js";
import { listSkills } from "../config/listSkills.js";
import {
  artifactMediaType,
  classifyArtifactContent,
  readRunArtifact,
  readRunArtifactBytes,
} from "../mcp/readArtifact.js";
import {
  getRunDiff,
  listCheckoutChanges,
  readCheckoutFileBytes,
} from "../mcp/checkoutTools.js";
import { readStageVerificationHistory } from "../runstore/verificationHistory.js";
import type { RunStoreKind } from "../runstore/createStore.js";
import {
  BackupError,
  createBackup,
  resolveBackupDownloadPath,
} from "../runstore/backup.js";
import {
  RestoreError,
  resolveBackupNameForRestore,
  stageRestoreForBoot,
} from "../runstore/restore.js";
import { iterateExportNdjson } from "../cli/exportAllCommand.js";
import {
  buildRunExportPayload,
  runDetailWithRedactedManifest,
} from "../runstore/exportRunPayload.js";
import { buildDebugBundle } from "../runstore/debugBundle.js";
import { parseShutdownGraceMs } from "./shutdown.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import type { RunStore } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import { PipelinePreflightError } from "../runtime/pipelineRunner.js";
import type {
  AbandonStageResult,
  CancelRunResult,
  DeleteRunResult,
  GcRunsResult,
  RunManager,
} from "../runtime/runManager.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import {
  INVALID_SLOT_COUNT_MESSAGE,
  INVALID_WORKSHOP_MODEL_MESSAGE,
  parseSlotCount,
  parseWorkshopModelSetting,
  readFactorySettings,
  writeFactorySettings,
} from "../runtime/settingsFile.js";
import { isTaskFile } from "../runtime/taskInput.js";
import {
  findTokenShapedField,
  tokenRejectedPayload,
} from "../runtime/startPayload.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { TaskFile } from "../types/task.js";
import {
  bootstrapStageflowHost,
  type StageflowHostOptions,
} from "./bootstrap.js";
import {
  assertAllowedHttpAccess,
  isTrustedLocalHttpRequest,
  resolveAllowedHosts,
  type AllowedHosts,
} from "./allowedHosts.js";
import {
  enforceBearerAuth,
  loadControlTokens,
  requiredScopeFor,
  type ControlTokens,
} from "./controlToken.js";
import {
  createHttpHost,
  DEFAULT_PORT,
  json,
  type HttpHostEnvelope,
  type HttpHostRouteContext,
} from "./createHttpHost.js";
import { handleApiHealth } from "./healthSurfaces.js";
import {
  mapRetryStageFailure,
  mapStartFailure,
  mapStoreLookupError,
} from "./operatorResults.js";
import {
  installShutdownController,
  makeDrainableHostFromOptional,
  type ShutdownController,
} from "./shutdown.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
  requestAuthFromBearer,
  runWithRequestAuth,
} from "./requestAuthContext.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";

const auditLog = rootLogger.child({ component: "audit" });

export type UiServerOptions = {
  agent: AgentPort;
  cwd?: string;
  agentDir?: string;
  rootDir?: string;
  store?: RunStore;
  storeKind?: RunStoreKind;
  port?: number;
  host?: string;
  uiDistDir?: string;
  maxConcurrent?: number;
  providerAuthContext?: ProviderAuthContext;
  mcpStateless?: boolean;
  runChangeBus?: RunChangeBus;
  allowedHosts?: AllowedHosts;
  controlTokens?: ControlTokens;
  /** Optional Workshop Operator Agent Host (fake in tests). */
  workshopOperatorHost?: OperatorAgentHost;
};

function textPlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(
  res: ServerResponse,
  uiDistDir: string,
  urlPath: string,
): Promise<boolean> {
  const safePath = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  let rel = safePath === "/" ? "index.html" : safePath.replace(/^\//, "");
  if (rel.includes("..")) {
    json(res, 400, { error: "Invalid path" });
    return true;
  }

  let filePath = path.join(uiDistDir, rel);
  try {
    await access(filePath);
  } catch {
    filePath = path.join(uiDistDir, "index.html");
    try {
      await access(filePath);
    } catch {
      return false;
    }
  }

  const data = await readFile(filePath);
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  res.end(data);
  return true;
}

function isCredentialMutatingApi(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return (
    /^\/api\/providers\/[^/]+\/login$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/answer$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/cancel$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/logout$/.test(pathname)
  );
}

export function defaultUiDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(path.dirname(here)) === "src") {
    return path.resolve(here, "../../dist/ui");
  }
  return path.resolve(here, "../ui");
}

export type OperatorRouteDeps = {
  manager: RunManager;
  store: RunStore;
  cwd: string;
  agentDir: string;
  rootDir: string;
  providerAuthContext: ProviderAuthContext | undefined;
  /** Omit for a headless service (e.g. `sf mcp`) — GETs outside the API surface just 404. */
  uiDistDir?: string;
  allowedHosts?: AllowedHosts;
  controlTokens?: ControlTokens;
  /** Live shutdown controller; set after listen so restore can beginDrain. */
  getShutdown?: () => import("./shutdown.js").ShutdownController | undefined;
  /**
   * Optional Operator Agent Host for Workshop chat (tests inject the fake host).
   * Distinct from stage-execution AgentPort. Defaults to live Pi Workshop Author
   * (fake remains available via createWorkshopOperatorHost / test injection).
   */
  workshopOperatorHost?: OperatorAgentHost;
  /**
   * Optional durable Workshop chat registry (host sessions keyed by session id).
   * Defaults to a registry owned by this route surface.
   */
  workshopChatRegistry?: WorkshopChatSessionRegistry;
};

/**
 * The full operator-console route surface: REST API (runs, stages,
 * catalog, settings, providers) plus, when `uiDistDir` is given, static
 * console UI file serving. Shared by `startUiServer` (browser-facing) and
 * `startMcpServer` (headless global-service daemon) — both need the REST
 * API; only the former needs the UI files.
 */
export function createOperatorRoutes(
  deps: OperatorRouteDeps,
): (ctx: HttpHostRouteContext) => Promise<boolean | void> {
  const {
    manager,
    store,
    cwd,
    agentDir,
    rootDir,
    providerAuthContext,
    uiDistDir,
    workshopOperatorHost,
  } = deps;
  const workshopChatRegistry =
    deps.workshopChatRegistry ??
    new WorkshopChatSessionRegistry(
      workshopOperatorHost ??
        createLiveWorkshopOperatorHost({
          cwd,
          projectRoot: cwd,
        }),
    );
  const workshopSessionStoreRoot = (): string =>
    resolveWorkshopSessionStoreRoot();
  const allowedHosts = deps.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = deps.controlTokens ?? loadControlTokens();
  return async ({ req, res, url, pathname, method, boot }) => {
      if (boot.serveBlocked !== undefined && pathname.startsWith("/api/")) {
        json(res, 503, {
          error: boot.serveBlocked.reason,
          code: boot.serveBlocked.code,
        });
        return true;
      }
      if (pathname.startsWith("/api/")) {
        if (
          !assertAllowedHttpAccess(allowedHosts, req, res, {
            requireOrigin: isCredentialMutatingApi(method, pathname),
          })
        ) {
          return true;
        }
        const scope = requiredScopeFor(method, pathname);
        if (scope !== null) {
          const authResult = enforceBearerAuth(
            controlTokens,
            req,
            res,
            scope,
          );
          if (!authResult.ok) return true;
          return runWithRequestAuth(
            requestAuthFromBearer(authResult.auth, "rest"),
            () => handleOperatorRequest(),
          );
        }
      }

      return handleOperatorRequest();

      async function handleOperatorRequest(): Promise<boolean> {
      try {
        if (method === "GET" && pathname === "/api/runs") {
          const filter: ListRunsFilter = {};
          const status = url.searchParams.get("status");
          const since = url.searchParams.get("since");
          const pipeline = url.searchParams.get("pipeline");
          const callerId = url.searchParams.get("caller_id");
          if (status !== null) filter.status = status as RunStatus;
          if (since !== null) filter.since = since;
          if (pipeline !== null) filter.pipeline = pipeline;
          if (callerId !== null) filter.caller_id = callerId;
          json(res, 200, {
            runs: await store.listRuns(
              Object.keys(filter).length > 0 ? filter : undefined,
            ),
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/backup") {
          const body = (await readJsonBody(req)) as {
            out?: unknown;
            db_only?: unknown;
            no_credentials?: unknown;
            include_a2a_artifacts?: unknown;
          };
          const callerId = callerIdFromRequestAuth();
          try {
            const result = await createBackup({
              store,
              homeDir: globalStageflowHome(),
              outPath: typeof body.out === "string" ? body.out : undefined,
              dbOnly: body.db_only === true,
              noCredentials: body.no_credentials === true,
              includeA2aArtifacts: body.include_a2a_artifacts === true,
            });
            writeAudit(auditLog, {
              caller_id: callerId,
              surface: getRequestAuth()?.surface ?? "rest",
              action: "backup",
              outcome: "ok",
            });
            json(res, 200, result);
          } catch (err) {
            if (err instanceof BackupError) {
              writeAudit(auditLog, {
                caller_id: callerId,
                surface: getRequestAuth()?.surface ?? "rest",
                action: "backup",
                outcome: "error",
                error_code: err.code,
              });
              const status =
                err.code === "backup_insufficient_disk" ? 507 : 400;
              json(res, status, { error: err.message, code: err.code });
              return true;
            }
            throw err;
          }
          return true;
        }

        const backupGetMatch = pathname.match(/^\/api\/backup\/([^/]+)$/);
        if (method === "GET" && backupGetMatch) {
          const name = decodeURIComponent(backupGetMatch[1] ?? "");
          try {
            const filePath = await resolveBackupDownloadPath(
              name,
              globalStageflowHome(),
            );
            const st = statSync(filePath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": st.size,
              "Content-Disposition": `attachment; filename="${name}"`,
            });
            createReadStream(filePath).pipe(res);
          } catch (err) {
            if (err instanceof BackupError) {
              json(res, 400, { error: err.message, code: err.code });
              return true;
            }
            throw err;
          }
          return true;
        }

        if (method === "POST" && pathname === "/api/restore") {
          const body = (await readJsonBody(req)) as {
            backup?: unknown;
            path?: unknown;
          };
          const backupName =
            typeof body.backup === "string"
              ? body.backup
              : typeof body.path === "string"
                ? body.path
                : undefined;
          if (backupName === undefined) {
            json(res, 400, {
              error: "body.backup (backup name under backups/) is required",
              code: "restore_not_found",
            });
            return true;
          }
          const callerId = callerIdFromRequestAuth();
          try {
            const archivePath = await resolveBackupNameForRestore(
              path.basename(backupName),
              globalStageflowHome(),
            );
            const graceMs = parseShutdownGraceMs();
            const staged = await stageRestoreForBoot({
              archivePath,
              homeDir: globalStageflowHome(),
              graceMs,
            });
            writeAudit(auditLog, {
              caller_id: callerId,
              surface: getRequestAuth()?.surface ?? "rest",
              action: "restore",
              outcome: "ok",
            });
            json(res, 202, {
              ok: true,
              staged: staged.stagedPath,
              drain_deadline: staged.marker.drain_deadline,
            });
            const shutdown = deps.getShutdown?.();
            if (shutdown !== undefined) {
              void shutdown.beginDrain();
            }
          } catch (err) {
            if (err instanceof RestoreError || err instanceof BackupError) {
              writeAudit(auditLog, {
                caller_id: callerId,
                surface: getRequestAuth()?.surface ?? "rest",
                action: "restore",
                outcome: "error",
                error_code: err.code,
              });
              json(res, 400, {
                error: err.message,
                code: err.code,
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        if (method === "GET" && pathname === "/api/export") {
          const filter: {
            status?: import("../runstore/port.js").RunStatus;
            since?: string;
            pipeline?: string;
            caller_id?: string;
          } = {};
          const status = url.searchParams.get("status");
          const since = url.searchParams.get("since");
          const pipeline = url.searchParams.get("pipeline");
          const callerId = url.searchParams.get("caller_id");
          if (status) filter.status = status as import("../runstore/port.js").RunStatus;
          if (since) filter.since = since;
          if (pipeline) filter.pipeline = pipeline;
          if (callerId) filter.caller_id = callerId;
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
          });
          try {
            for await (const line of iterateExportNdjson({
              store,
              filter: Object.keys(filter).length > 0 ? filter : undefined,
            })) {
              if (req.aborted || res.writableEnded || res.destroyed) {
                break;
              }
              if (!res.write(line)) {
                await new Promise<void>((resolve) => res.once("drain", resolve));
              }
            }
            if (!res.writableEnded && !res.destroyed) {
              res.end();
            }
          } catch (err) {
            if (res.headersSent) {
              res.destroy(err instanceof Error ? err : new Error(String(err)));
            } else {
              throw err;
            }
          }
          return true;
        }

        const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifact$/);
        if (method === "GET" && artifactMatch) {
          const runId = decodeURIComponent(artifactMatch[1] ?? "");
          const artifactPath = url.searchParams.get("path");
          if (artifactPath === null || artifactPath.trim().length === 0) {
            json(res, 400, { error: "path query parameter is required" });
            return true;
          }
          try {
            const mediaType = artifactMediaType(artifactPath);
            if (mediaType !== undefined) {
              const bytes = await readRunArtifactBytes(store, runId, artifactPath);
              res.writeHead(200, {
                "Content-Type": mediaType,
                "Content-Length": bytes.length,
              });
              res.end(bytes);
            } else {
              const content = await readRunArtifact(store, runId, artifactPath);
              textPlain(res, 200, content);
            }
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "artifact" });
            const status = mapped.kind === "denied" ? 403 : mapped.status;
            json(res, status, { error: mapped.error });
          }
          return true;
        }

        const changesMatch = pathname.match(/^\/api\/runs\/([^/]+)\/changes$/);
        if (method === "GET" && changesMatch) {
          const runId = decodeURIComponent(changesMatch[1] ?? "");
          try {
            const result = await listCheckoutChanges(store, runId);
            if (!result.ok) {
              json(res, result.status, {
                error: result.error,
                code: result.code,
              });
              return true;
            }
            json(res, 200, {
              runId,
              changes: result.changes,
              truncated: result.truncated,
            });
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "run" });
            json(res, mapped.status, { error: mapped.error });
          }
          return true;
        }

        const diffMatch = pathname.match(/^\/api\/runs\/([^/]+)\/diff$/);
        if (method === "GET" && diffMatch) {
          const runId = decodeURIComponent(diffMatch[1] ?? "");
          const modeParam = url.searchParams.get("mode");
          const mode =
            modeParam === "patch" || modeParam === "stat" ? modeParam : undefined;
          const filterPath = url.searchParams.get("path") ?? undefined;
          const maxBytesRaw = url.searchParams.get("maxBytes");
          const maxBytes =
            maxBytesRaw !== null && maxBytesRaw.trim() !== ""
              ? Number(maxBytesRaw)
              : undefined;
          try {
            const result = await getRunDiff(store, runId, {
              mode,
              path: filterPath ?? undefined,
              maxBytes:
                maxBytes !== undefined && Number.isFinite(maxBytes)
                  ? maxBytes
                  : undefined,
            });
            if (!result.ok) {
              json(res, result.status, {
                error: result.error,
                code: result.code,
              });
              return true;
            }
            json(res, 200, {
              runId,
              mode: result.mode,
              base_sha: result.base_sha,
              base_source: result.base_source,
              content: result.content,
              truncated: result.truncated,
              untracked: result.untracked,
            });
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "run" });
            json(res, mapped.status, { error: mapped.error });
          }
          return true;
        }

        const checkoutFileMatch = pathname.match(/^\/api\/runs\/([^/]+)\/file$/);
        if (method === "GET" && checkoutFileMatch) {
          const runId = decodeURIComponent(checkoutFileMatch[1] ?? "");
          const filePath = url.searchParams.get("path");
          if (filePath === null || filePath.trim().length === 0) {
            json(res, 400, { error: "path query parameter is required" });
            return true;
          }
          try {
            const result = await readCheckoutFileBytes(store, runId, filePath);
            if (!result.ok) {
              json(res, result.status, {
                error: result.error,
                code: result.code,
              });
              return true;
            }
            const mediaType = artifactMediaType(filePath);
            if (mediaType !== undefined) {
              res.writeHead(200, {
                "Content-Type": mediaType,
                "Content-Length": result.bytes.length,
              });
              res.end(result.bytes);
            } else {
              const classified = classifyArtifactContent(filePath, result.bytes);
              if (classified.kind !== "utf8") {
                json(res, 400, {
                  error: "Checkout file is not valid UTF-8 text",
                });
                return true;
              }
              textPlain(res, 200, result.bytes.toString("utf8"));
            }
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "artifact" });
            const status = mapped.kind === "denied" ? 403 : mapped.status;
            json(res, status, { error: mapped.error });
          }
          return true;
        }

        const verificationMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/verification$/,
        );
        if (method === "GET" && verificationMatch) {
          const runId = decodeURIComponent(verificationMatch[1] ?? "");
          const stageId = decodeURIComponent(verificationMatch[2] ?? "");
          try {
            json(res, 200, await readStageVerificationHistory(store, runId, stageId));
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "run" });
            json(res, mapped.status, { error: mapped.error });
          }
          return true;
        }

        const exportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/export$/);
        if (method === "GET" && exportMatch) {
          const runId = decodeURIComponent(exportMatch[1] ?? "");
          try {
            const detail = await store.readRun(runId);
            json(res, 200, buildRunExportPayload(detail));
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "run" });
            json(res, mapped.status, { error: mapped.error });
          }
          return true;
        }

        const debugBundleMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/debug-bundle$/,
        );
        if (method === "GET" && debugBundleMatch) {
          const runId = decodeURIComponent(debugBundleMatch[1] ?? "");
          try {
            json(res, 200, await buildDebugBundle(store, runId));
          } catch (err) {
            const mapped = mapStoreLookupError(err, { policy: "run" });
            json(res, mapped.status, { error: mapped.error });
          }
          return true;
        }

        if (method === "GET" && pathname.startsWith("/api/runs/")) {
          const rest = pathname.slice("/api/runs/".length);
          if (rest && !rest.includes("/")) {
            try {
              const detail = await store.readRun(decodeURIComponent(rest));
              json(res, 200, runDetailWithRedactedManifest(detail));
            } catch (err) {
              const mapped = mapStoreLookupError(err, { policy: "run" });
              json(res, 404, { error: mapped.error });
            }
            return true;
          }
        }

        if (method === "POST" && pathname === "/api/projects") {
          if (!isTrustedLocalHttpRequest(req)) {
            json(res, 403, {
              error:
                "ensure_project is only allowed from trusted local clients (loopback peer and Host)",
              code: "ensure_project_not_allowed",
            });
            return true;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const projectRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root.trim()
              : "";
          if (!projectRoot) {
            json(res, 400, { error: "project_root is required" });
            return true;
          }
          if (!path.isAbsolute(projectRoot)) {
            json(res, 400, {
              error: "project_root must be an absolute path",
            });
            return true;
          }
          try {
            const registered = await store.ensureProject(projectRoot);
            json(res, 200, { project_root: registered });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            json(res, 400, {
              error: message,
              code: "invalid_project_root",
            });
          }
          return true;
        }

        if (method === "POST" && pathname === "/api/runs") {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const tokenField = findTokenShapedField(body);
          if (tokenField !== undefined) {
            json(res, 400, tokenRejectedPayload(tokenField));
            return true;
          }
          const typed = body as {
            task?: string | TaskFile;
            pipeline?: string;
            project_root?: string;
            checkoutOverride?: string;
            skipGates?: boolean;
            gitSha?: string;
            ciPrUrl?: string;
            ciJobUrl?: string;
            skills?: Record<string, Record<string, string>>;
          };
          if (
            typeof typed.pipeline !== "string" ||
            !typed.pipeline.trim() ||
            typed.task === undefined
          ) {
            json(res, 400, { error: "task and pipeline are required" });
            return true;
          }
          if (typeof typed.task !== "string" && !isTaskFile(typed.task)) {
            json(res, 400, {
              error:
                "task must be a path string or TaskFile object (id and goal required)",
            });
            return true;
          }
          if (
            typed.checkoutOverride !== undefined &&
            typeof typed.checkoutOverride !== "string"
          ) {
            json(res, 400, { error: "checkoutOverride must be a string" });
            return true;
          }
          if (typed.skipGates !== undefined && typeof typed.skipGates !== "boolean") {
            json(res, 400, { error: "skipGates must be a boolean" });
            return true;
          }
          for (const field of ["gitSha", "ciPrUrl", "ciJobUrl"] as const) {
            if (typed[field] !== undefined && typeof typed[field] !== "string") {
              json(res, 400, { error: `${field} must be a string` });
              return true;
            }
          }
          let wireRoot;
          let roots;
          try {
            ({ wireRoot, roots } = await resolveCatalogStartInput(
              { store, bootCwd: cwd },
              typed.project_root,
            ));
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const wireProjectRoot = wireRoot.project_root;
          let pipelinePath = typed.pipeline.trim();
          let taskInput: string | TaskFile = typed.task;
          let checkoutOverride: string | undefined;
          try {
            pipelinePath = resolveCatalogRelativePath({
              inputPath: pipelinePath,
              projectRoot: wireProjectRoot,
              roots,
              fieldName: "pipeline",
            }).absolutePath;
            if (typeof typed.task === "string") {
              taskInput = resolveCatalogRelativePath({
                inputPath: typed.task,
                projectRoot: wireProjectRoot,
                roots,
                fieldName: "task",
              }).absolutePath;
            }
            if (typed.checkoutOverride !== undefined) {
              checkoutOverride = resolveCatalogRelativePath({
                inputPath: typed.checkoutOverride,
                projectRoot: wireProjectRoot,
                roots,
                fieldName: "checkout",
              }).absolutePath;
            }
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          let result: Awaited<ReturnType<typeof manager.startRun>>;
          const callerId = callerIdFromRequestAuth();
          try {
            result = await manager.startRun({
              task: taskInput,
              pipeline: pipelinePath,
              projectRoot: wireRoot.path,
              ...(checkoutOverride !== undefined
                ? { checkoutOverride }
                : {}),
              ...(typed.skipGates !== undefined ? { skipGates: typed.skipGates } : {}),
              ...(typed.gitSha !== undefined ? { gitSha: typed.gitSha } : {}),
              ...(typed.ciPrUrl !== undefined ? { ciPrUrl: typed.ciPrUrl } : {}),
              ...(typed.ciJobUrl !== undefined ? { ciJobUrl: typed.ciJobUrl } : {}),
              ...(typed.skills !== undefined ? { skills: typed.skills } : {}),
              callerId,
            });
          } catch (err) {
            if (err instanceof PipelineValidationError) {
              writeAudit(auditLog, {
                caller_id: callerId,
                surface: getRequestAuth()?.surface ?? "rest",
                action: "start_run",
                outcome: "error",
                error_code: "pipeline_validation",
              });
              json(res, 400, {
                error: "Pipeline validation failed",
                validation: err.result,
              });
              return true;
            }
            if (err instanceof PipelinePreflightError) {
              writeAudit(auditLog, {
                caller_id: callerId,
                surface: getRequestAuth()?.surface ?? "rest",
                action: "start_run",
                outcome: "error",
                error_code: err.code,
              });
              json(res, 400, err.toNetworkBody());
              return true;
            }
            throw err;
          }
          if (!result.ok) {
            writeAudit(auditLog, {
              caller_id: callerId,
              surface: getRequestAuth()?.surface ?? "rest",
              action: "start_run",
              outcome: "error",
              error_code: result.code,
            });
            json(res, result.status ?? 500, mapStartFailure(result));
            return true;
          }
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "rest",
            action: "start_run",
            target_run_id: result.runId,
            outcome: "ok",
          });
          json(res, 202, {
            runId: result.runId,
            ...(result.queued === true
              ? {
                  queued: true,
                  queuePosition: result.queuePosition,
                  ...(result.queuedCode !== undefined
                    ? { queuedCode: result.queuedCode }
                    : {}),
                }
              : {}),
          });
          return true;
        }

        if (method === "POST" && pathname.match(/^\/api\/runs\/[^/]+\/rerun$/)) {
          const runId = decodeURIComponent(pathname.split("/")[3] ?? "");
          const body = (await readJsonBody(req)) as {
            pinned?: boolean;
          };
          if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
            json(res, 400, { error: "pinned must be a boolean" });
            return true;
          }
          const callerId = callerIdFromRequestAuth();
          const result = await manager.rerun(runId, {
            ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
            callerId,
          });
          if (!result.ok) {
            writeAudit(auditLog, {
              caller_id: callerId,
              surface: getRequestAuth()?.surface ?? "rest",
              action: "rerun",
              target_run_id: runId,
              outcome: "error",
              error_code: result.code,
            });
            json(res, result.status ?? 500, mapStartFailure(result));
            return true;
          }
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "rest",
            action: "rerun",
            target_run_id: result.runId,
            outcome: "ok",
          });
          json(res, 202, { runId: result.runId });
          return true;
        }

        const answerMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/answer$/,
        );
        if (method === "POST" && answerMatch) {
          const runId = decodeURIComponent(answerMatch[1] ?? "");
          const stageId = decodeURIComponent(answerMatch[2] ?? "");
          let answer;
          try {
            answer = parseAskOperatorAnswer(await readJsonBody(req));
          } catch (err) {
            json(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
            return true;
          }

          const result = await manager.deliverAnswer(runId, stageId, answer);
          if (!result.ok) {
            json(res, result.status, { error: result.reason });
            return true;
          }
          json(res, 202, { ok: true });
          return true;
        }

        const feedbackDecisionMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/feedback-decision$/,
        );
        if (method === "POST" && feedbackDecisionMatch) {
          const runId = decodeURIComponent(feedbackDecisionMatch[1] ?? "");
          const stageId = decodeURIComponent(feedbackDecisionMatch[2] ?? "");
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            json(res, 400, { error: "Body must be a JSON object" });
            return true;
          }
          const raw = body as {
            decision?: unknown;
            loopId?: unknown;
            reason?: unknown;
          };
          if (
            raw.decision !== "extend" &&
            raw.decision !== "continue" &&
            raw.decision !== "abandon"
          ) {
            json(res, 400, {
              error: "decision must be extend, continue, or abandon",
            });
            return true;
          }
          if (raw.loopId !== undefined && typeof raw.loopId !== "string") {
            json(res, 400, { error: "loopId must be a string" });
            return true;
          }
          if (raw.reason !== undefined && typeof raw.reason !== "string") {
            json(res, 400, { error: "reason must be a string" });
            return true;
          }
          const result = await manager.decideFeedbackLoop(runId, stageId, {
            decision: raw.decision,
            ...(raw.loopId !== undefined ? { loopId: raw.loopId } : {}),
            ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
          });
          if (!result.ok) {
            json(res, result.status ?? 500, { error: result.reason });
            return true;
          }
          json(res, 202, {
            ok: true,
            effect: result.effect,
            loopId: result.loopId,
          });
          return true;
        }

        const retryMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/retry$/,
        );
        if (method === "POST" && retryMatch) {
          await readJsonBody(req);
          const runId = decodeURIComponent(retryMatch[1] ?? "");
          const stageId = decodeURIComponent(retryMatch[2] ?? "");
          const result = await manager.retryStage(runId, stageId);
          if (!result.ok) {
            json(res, result.status ?? 500, mapRetryStageFailure(result));
            return true;
          }
          json(res, 202, {
            runId: result.runId,
            stageId: result.stageId,
            attemptIndex: result.attemptIndex,
          });
          return true;
        }

        const resumeMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/resume$/,
        );
        if (method === "POST" && resumeMatch) {
          await readJsonBody(req);
          const runId = decodeURIComponent(resumeMatch[1] ?? "");
          const stageId = decodeURIComponent(resumeMatch[2] ?? "");
          const result = await manager.resumeTimedOutStage(runId, stageId);
          if (!result.ok) {
            json(res, result.status ?? 500, mapRetryStageFailure(result));
            return true;
          }
          json(res, 202, {
            runId: result.runId,
            stageId: result.stageId,
            attemptIndex: result.attemptIndex,
          });
          return true;
        }

        const recoverMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/recovery$/,
        );
        if (method === "POST" && recoverMatch) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const guidance =
            body !== null && typeof body === "object" && !Array.isArray(body)
              ? (body as { guidance?: unknown }).guidance
              : undefined;
          if (guidance !== undefined && typeof guidance !== "string") {
            json(res, 400, { error: "guidance must be a string" });
            return true;
          }
          const runId = decodeURIComponent(recoverMatch[1] ?? "");
          const stageId = decodeURIComponent(recoverMatch[2] ?? "");
          const result = await manager.recoverManualStage(runId, stageId, guidance);
          if (!result.ok) {
            json(res, result.status ?? 500, mapRetryStageFailure(result));
            return true;
          }
          json(res, 202, {
            runId: result.runId,
            stageId: result.stageId,
            attemptIndex: result.attemptIndex,
          });
          return true;
        }

        const stopRecoveryMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/recovery\/stop$/,
        );
        if (method === "POST" && stopRecoveryMatch) {
          await readJsonBody(req);
          const runId = decodeURIComponent(stopRecoveryMatch[1] ?? "");
          const stageId = decodeURIComponent(stopRecoveryMatch[2] ?? "");
          const result = await manager.stopManualRecovery(runId, stageId);
          if (!result.ok) {
            json(res, result.status ?? 500, { error: result.reason });
            return true;
          }
          json(res, 202, result);
          return true;
        }

        const abandonMatch = pathname.match(
          /^\/api\/runs\/([^/]+)\/stages\/([^/]+)\/abandon$/,
        );
        if (method === "POST" && abandonMatch) {
          await readJsonBody(req);
          const runId = decodeURIComponent(abandonMatch[1] ?? "");
          const stageId = decodeURIComponent(abandonMatch[2] ?? "");
          const result = await manager.abandonStage(runId, stageId);
          if (!result.ok) {
            json(res, result.status ?? 500, {
              error: (result as Extract<AbandonStageResult, { ok: false }>).reason,
            });
            return true;
          }
          json(res, 202, {
            ok: true,
            runId: result.runId,
            stageId: result.stageId,
          });
          return true;
        }

        const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
        if (method === "POST" && cancelMatch) {
          const body = (await readJsonBody(req)) as { reason?: unknown };
          const runId = decodeURIComponent(cancelMatch[1] ?? "");
          if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
            json(res, 400, { error: "Cancel reason is required" });
            return true;
          }
          const result = await manager.cancelRun(runId, body.reason);
          if (!result.ok) {
            json(res, result.status ?? 500, {
              error: (result as Extract<CancelRunResult, { ok: false }>).reason,
            });
            return true;
          }
          json(res, 202, {
            ok: true,
            runId: result.runId,
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/runs/gc") {
          const body = (await readJsonBody(req)) as { execute?: unknown };
          const execute = body.execute === true;
          const result = await manager.gcRuns({ execute, channel: "rest" });
          if (!result.ok) {
            json(res, result.status ?? 500, {
              error: (result as Extract<GcRunsResult, { ok: false }>).reason,
            });
            return true;
          }
          json(res, 200, {
            slimmed: result.slimmed,
            purged: result.purged,
            bareCachesEvicted: result.bareCachesEvicted,
          });
          return true;
        }

        const deleteMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (method === "DELETE" && deleteMatch) {
          const runId = decodeURIComponent(deleteMatch[1] ?? "");
          const forceParam = url.searchParams.get("force");
          const force = forceParam === "true" || forceParam === "1";
          const result = await manager.deleteRun(runId, {
            force,
            channel: "rest",
          });
          if (!result.ok) {
            json(res, result.status ?? 500, {
              error: (result as Extract<DeleteRunResult, { ok: false }>).reason,
            });
            return true;
          }
          json(res, 200, {
            ok: true,
            runId: result.runId,
          });
          return true;
        }

        if (method === "GET" && pathname === "/api/tasks") {
          const filter = url.searchParams.get("project_root") ?? undefined;
          const result = await listTasksMultiProject({
            store,
            bootCwd: cwd,
            projectRootFilter: filter,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            json(res, 400, {
              error: result.root_errors[0]!.message,
              code: "unknown_project_root",
              root_errors: result.root_errors,
            });
            return true;
          }
          json(res, 200, {
            tasks: result.items,
            root_errors: result.root_errors,
            ...(result.tip !== undefined ? { tip: result.tip } : {}),
          });
          return true;
        }

        if (method === "GET" && pathname === "/api/pipelines") {
          const filter = url.searchParams.get("project_root") ?? undefined;
          const result = await listPipelinesMultiProject({
            store,
            bootCwd: cwd,
            projectRootFilter: filter,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            json(res, 400, {
              error: result.root_errors[0]!.message,
              code: "unknown_project_root",
              root_errors: result.root_errors,
            });
            return true;
          }
          json(res, 200, {
            pipelines: result.items,
            root_errors: result.root_errors,
            ...(result.tip !== undefined ? { tip: result.tip } : {}),
          });
          return true;
        }

        if (method === "GET" && pathname === "/api/stages") {
          json(res, 404, {
            error: "Global stage library removed; stages are pipeline-scoped",
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/stages") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let stageWriteRoot: string;
          try {
            const { wireRoot: selected } = await resolveWritableCatalogRoot(
              { store, bootCwd: cwd },
              writeRoot,
            );
            stageWriteRoot = selected.path;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const parsed = parseCreateStageBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(stageWriteRoot);
          if (!ctx.isGitProject) {
            json(res, 400, {
              error:
                "Project root not found; initialize stageflow.yaml in a git repo",
            });
            return true;
          }
          const result = await createStage(ctx.projectRoot, parsed);
          if (!result.ok) {
            json(res, result.status, { error: result.error });
            return true;
          }
          json(res, 201, result.stage);
          return true;
        }

        if (method === "POST" && pathname === "/api/pipelines") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let pipelineWriteRoot: string;
          try {
            const { wireRoot: selected } = await resolveWritableCatalogRoot(
              { store, bootCwd: cwd },
              writeRoot,
            );
            pipelineWriteRoot = selected.path;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const parsed = parseCreatePipelineBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(pipelineWriteRoot);
          if (!ctx.isGitProject) {
            json(res, 400, {
              error:
                "Project root not found; initialize stageflow.yaml in a git repo",
            });
            return true;
          }
          const result = await createPipeline(ctx.projectRoot, parsed);
          if (!result.ok) {
            json(res, result.status, { error: result.error });
            return true;
          }
          json(res, 201, result.pipeline);
          return true;
        }

        if (method === "POST" && pathname === "/api/drafts/validate") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const draftParsed = parseDraftPackageBody(body);
          if ("ok" in draftParsed) {
            json(res, draftParsed.status, { error: draftParsed.error });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let validateRoot = cwd;
          if (writeRoot) {
            try {
              const { wireRoot: selected } = await resolveWritableCatalogRoot(
                { store, bootCwd: cwd },
                writeRoot,
              );
              validateRoot = selected.path;
            } catch (err) {
              if (err instanceof CatalogPathError) {
                json(
                  res,
                  err.code === "catalog_root_read_only" ? 403 : 400,
                  catalogPathErrorBody(err),
                );
                return true;
              }
              throw err;
            }
          }
          const ctx = await resolveStageflowContext(validateRoot);
          const result = await validateDraftPackage(draftParsed, {
            cwd: ctx.projectRoot,
            projectRoot: ctx.projectRoot,
            strict: true,
          });
          json(res, 200, result);
          return true;
        }

        if (method === "POST" && pathname === "/api/drafts/create") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let draftWriteRoot: string;
          try {
            const { wireRoot: selected } = await resolveWritableCatalogRoot(
              { store, bootCwd: cwd },
              writeRoot,
            );
            draftWriteRoot = selected.path;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const parsed = parseCreateDraftPackageBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(draftWriteRoot);
          if (!ctx.isGitProject) {
            json(res, 400, {
              error:
                "Project root not found; initialize stageflow.yaml in a git repo",
            });
            return true;
          }
          const result = await createDraftPackage(ctx.projectRoot, parsed);
          if (!result.ok) {
            json(res, result.status, {
              error: result.error,
              ...(result.findings ? { findings: result.findings } : {}),
            });
            return true;
          }
          json(res, 201, {
            pipeline: result.pipeline,
            pipelinePath: result.pipelinePath,
            stagePaths: result.stagePaths,
            ...(result.taskPath !== undefined ? { taskPath: result.taskPath } : {}),
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/drafts/overwrite") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let draftWriteRoot: string;
          try {
            const { wireRoot: selected } = await resolveWritableCatalogRoot(
              { store, bootCwd: cwd },
              writeRoot,
            );
            draftWriteRoot = selected.path;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const parsed = parseOverwriteDraftPackageBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(draftWriteRoot);
          if (!ctx.isGitProject) {
            json(res, 400, {
              error:
                "Project root not found; initialize stageflow.yaml in a git repo",
            });
            return true;
          }
          const result = await overwriteDraftPackage(ctx.projectRoot, parsed);
          if (!result.ok) {
            json(res, result.status, {
              error: result.error,
              ...(result.findings ? { findings: result.findings } : {}),
            });
            return true;
          }
          json(res, 200, {
            pipeline: result.pipeline,
            pipelinePath: result.pipelinePath,
            stagePaths: result.stagePaths,
            ...(result.taskPath !== undefined ? { taskPath: result.taskPath } : {}),
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/drafts/open") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const parsed = parseOpenDraftPackageBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let wireRoot;
          let roots;
          try {
            ({ wireRoot, roots } = await resolveCatalogStartInput(
              { store, bootCwd: cwd },
              writeRoot,
            ));
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          let pipelineRel: string;
          let taskRel: string | undefined;
          try {
            pipelineRel = resolveCatalogRelativePath({
              inputPath: parsed.path,
              projectRoot: writeRoot,
              roots,
              fieldName: "path",
            }).relativePath;
            if (parsed.taskPath) {
              taskRel = resolveCatalogRelativePath({
                inputPath: parsed.taskPath,
                projectRoot: writeRoot,
                roots,
                fieldName: "task",
              }).relativePath;
            }
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const ctx = await resolveStageflowContext(wireRoot.path);
          const result = await loadDraftPackage(ctx.projectRoot, pipelineRel, {
            ...(taskRel !== undefined ? { taskPath: taskRel } : {}),
          });
          if (!result.ok) {
            json(res, result.status, { error: result.error });
            return true;
          }
          json(res, 200, {
            draft: result.draft,
            destination: result.destination,
            pipelinePath: result.pipelinePath,
            ...(result.taskPath !== undefined ? { taskPath: result.taskPath } : {}),
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/drafts/attach-task") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const parsed = parseAttachTaskBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const writeRoot =
            body !== null &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as { project_root?: unknown }).project_root === "string"
              ? (body as { project_root: string }).project_root
              : undefined;
          let wireRoot;
          let roots;
          try {
            ({ wireRoot, roots } = await resolveCatalogStartInput(
              { store, bootCwd: cwd },
              writeRoot,
            ));
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          let taskRel: string;
          try {
            taskRel = resolveCatalogRelativePath({
              inputPath: parsed.taskPath,
              projectRoot: writeRoot,
              roots,
              fieldName: "task",
            }).relativePath;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(res, 400, catalogPathErrorBody(err));
              return true;
            }
            throw err;
          }
          const ctx = await resolveStageflowContext(wireRoot.path);
          const result = await loadTaskArtifact(ctx.projectRoot, taskRel);
          if (!result.ok) {
            json(res, result.status, { error: result.error });
            return true;
          }
          json(res, 200, {
            task: result.task,
            taskPath: result.taskPath,
          });
          return true;
        }

        if (
          method === "GET" &&
          pathname === "/api/workshop/autosave"
        ) {
          const keyParam = url.searchParams.get("key");
          const key = workshopAutosaveSlotKey(keyParam);
          const writeRoot =
            url.searchParams.get("project_root") ?? undefined;
          let storeRoot: string;
          try {
            if (writeRoot) {
              const { wireRoot } = await resolveCatalogStartInput(
                { store, bootCwd: cwd },
                writeRoot,
              );
              const ctx = await resolveStageflowContext(wireRoot.path);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.projectRoot,
                isGitProject: ctx.isGitProject,
              });
            } else {
              const ctx = await resolveStageflowContext(cwd);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.isGitProject ? ctx.projectRoot : null,
                isGitProject: ctx.isGitProject,
              });
            }
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(
                res,
                err.code === "catalog_root_read_only" ? 403 : 400,
                catalogPathErrorBody(err),
              );
              return true;
            }
            throw err;
          }
          const record = readWorkshopAutosave(storeRoot, key);
          json(res, 200, { key, autosave: record });
          return true;
        }

        if (
          method === "PUT" &&
          pathname === "/api/workshop/autosave"
        ) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const key = workshopAutosaveSlotKey(
            typeof body.key === "string" ? body.key : undefined,
          );
          const writeRoot =
            typeof body.project_root === "string"
              ? body.project_root
              : undefined;
          let storeRoot: string;
          try {
            if (writeRoot) {
              const { wireRoot } = await resolveWritableCatalogRoot(
                { store, bootCwd: cwd },
                writeRoot,
              );
              const ctx = await resolveStageflowContext(wireRoot.path);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.projectRoot,
                isGitProject: ctx.isGitProject,
              });
            } else {
              const ctx = await resolveStageflowContext(cwd);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.isGitProject ? ctx.projectRoot : null,
                isGitProject: ctx.isGitProject,
              });
            }
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(
                res,
                err.code === "catalog_root_read_only" ? 403 : 400,
                catalogPathErrorBody(err),
              );
              return true;
            }
            throw err;
          }
          const candidate: WorkshopAutosaveRecord = {
            version: 1,
            key,
            updatedAt:
              typeof body.updatedAt === "string" && body.updatedAt
                ? body.updatedAt
                : new Date().toISOString(),
            draft: body.draft as WorkshopAutosaveRecord["draft"],
            messages:
              body.messages as WorkshopAutosaveRecord["messages"],
            autoApply: Boolean(body.autoApply),
            ...(body.sessionModelOverride === null ||
            typeof body.sessionModelOverride === "string"
              ? { sessionModelOverride: body.sessionModelOverride }
              : {}),
            ...(body.destination !== undefined
              ? {
                  destination:
                    body.destination as WorkshopAutosaveRecord["destination"],
                }
              : {}),
            ...(body.savedPath === null || typeof body.savedPath === "string"
              ? { savedPath: body.savedPath }
              : {}),
            ...(body.savedTaskPath === null ||
            typeof body.savedTaskPath === "string"
              ? { savedTaskPath: body.savedTaskPath }
              : {}),
            ...(isPlainObject(body.diskFingerprints)
              ? {
                  diskFingerprints:
                    body.diskFingerprints as Record<string, string>,
                }
              : {}),
          };
          const parsed = parseWorkshopAutosaveRecord(candidate);
          if (!parsed) {
            json(res, 400, { error: "Invalid workshop autosave payload" });
            return true;
          }
          const written = writeWorkshopAutosave(storeRoot, parsed);
          json(res, 200, { autosave: written });
          return true;
        }

        if (
          method === "DELETE" &&
          pathname === "/api/workshop/autosave"
        ) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const key = workshopAutosaveSlotKey(
            typeof body.key === "string" ? body.key : undefined,
          );
          const writeRoot =
            typeof body.project_root === "string"
              ? body.project_root
              : undefined;
          let storeRoot: string;
          try {
            if (writeRoot) {
              const { wireRoot } = await resolveWritableCatalogRoot(
                { store, bootCwd: cwd },
                writeRoot,
              );
              const ctx = await resolveStageflowContext(wireRoot.path);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.projectRoot,
                isGitProject: ctx.isGitProject,
              });
            } else {
              const ctx = await resolveStageflowContext(cwd);
              storeRoot = resolveWorkshopAutosaveStoreRoot({
                projectRoot: ctx.isGitProject ? ctx.projectRoot : null,
                isGitProject: ctx.isGitProject,
              });
            }
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(
                res,
                err.code === "catalog_root_read_only" ? 403 : 400,
                catalogPathErrorBody(err),
              );
              return true;
            }
            throw err;
          }
          const cleared = clearWorkshopAutosave(storeRoot, key);
          json(res, 200, { key, cleared });
          return true;
        }

        if (
          method === "GET" &&
          pathname === "/api/workshop/sessions"
        ) {
          const sessions = listWorkshopSessions(workshopSessionStoreRoot());
          json(res, 200, { sessions });
          return true;
        }

        if (
          method === "POST" &&
          pathname === "/api/workshop/sessions"
        ) {
          let body: unknown = {};
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const record = createWorkshopSession(workshopSessionStoreRoot(), {
            ...(typeof body.id === "string" ? { id: body.id } : {}),
          });
          json(res, 201, { session: record });
          return true;
        }

        const workshopSessionGetMatch = pathname.match(
          /^\/api\/workshop\/sessions\/([^/]+)$/,
        );
        if (method === "GET" && workshopSessionGetMatch) {
          const sessionId = decodeURIComponent(
            workshopSessionGetMatch[1] ?? "",
          );
          try {
            const session = getWorkshopSession(
              workshopSessionStoreRoot(),
              sessionId,
            );
            json(res, 200, { session });
          } catch (err) {
            if (
              err instanceof WorkshopSessionStoreError &&
              err.code === "workshop_session_not_found"
            ) {
              json(res, 404, {
                error: err.message,
                code: err.code,
                sessionId: err.sessionId,
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        const workshopSessionUndoMatch = pathname.match(
          /^\/api\/workshop\/sessions\/([^/]+)\/undo$/,
        );
        if (method === "POST" && workshopSessionUndoMatch) {
          const sessionId = decodeURIComponent(
            workshopSessionUndoMatch[1] ?? "",
          );
          let body: unknown = {};
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const draftParsed = parseDraftPackageBody(body);
          if ("ok" in draftParsed) {
            json(res, draftParsed.status, { error: draftParsed.error });
            return true;
          }
          try {
            const result = await undoWorkshopSessionMutation({
              sessionId,
              draft: draftParsed,
              ...(typeof body.mutationId === "string"
                ? { mutationId: body.mutationId }
                : {}),
              registry: workshopChatRegistry,
              storeRoot: workshopSessionStoreRoot(),
            });
            json(res, result.ok ? 200 : 409, result);
          } catch (err) {
            if (
              err instanceof WorkshopSessionStoreError &&
              err.code === "workshop_session_not_found"
            ) {
              json(res, 404, {
                error: err.message,
                code: err.code,
                sessionId: err.sessionId,
              });
              return true;
            }
            json(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        const workshopSessionAcceptMatch = pathname.match(
          /^\/api\/workshop\/sessions\/([^/]+)\/accept$/,
        );
        if (method === "POST" && workshopSessionAcceptMatch) {
          const sessionId = decodeURIComponent(
            workshopSessionAcceptMatch[1] ?? "",
          );
          let body: unknown = {};
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const draftParsed = parseDraftPackageBody(body);
          if ("ok" in draftParsed) {
            json(res, draftParsed.status, { error: draftParsed.error });
            return true;
          }
          try {
            const result = await acceptWorkshopSessionMutation({
              sessionId,
              draft: draftParsed,
              ...(typeof body.mutationId === "string"
                ? { mutationId: body.mutationId }
                : {}),
              registry: workshopChatRegistry,
              storeRoot: workshopSessionStoreRoot(),
            });
            json(res, result.ok ? 200 : 409, result);
          } catch (err) {
            if (
              err instanceof WorkshopSessionStoreError &&
              err.code === "workshop_session_not_found"
            ) {
              json(res, 404, {
                error: err.message,
                code: err.code,
                sessionId: err.sessionId,
              });
              return true;
            }
            json(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        if (method === "POST" && pathname === "/api/workshop/chat") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
            json(res, 400, { error: "sessionId is required" });
            return true;
          }
          if (typeof body.message !== "string" || !body.message.trim()) {
            json(res, 400, { error: "message is required" });
            return true;
          }
          const draftParsed = parseDraftPackageBody(body);
          if ("ok" in draftParsed) {
            json(res, draftParsed.status, { error: draftParsed.error });
            return true;
          }
          const settingsDefault = readFactorySettings(cwd).workshopModel;
          const accept = String(req.headers.accept ?? "");
          const wantsStream =
            body.stream === true ||
            accept.includes("application/x-ndjson") ||
            accept.includes("text/event-stream");
          const chatTurnBase = {
            sessionId: body.sessionId,
            draft: draftParsed,
            message: body.message,
            autoApply: body.autoApply === true,
            model:
              typeof body.model === "string" || body.model === null
                ? body.model
                : undefined,
            settingsDefault: settingsDefault ?? null,
            registry: workshopChatRegistry,
            storeRoot: workshopSessionStoreRoot(),
          };

          // Fail closed on missing sessions before opening an NDJSON body.
          try {
            getWorkshopSession(workshopSessionStoreRoot(), body.sessionId);
          } catch (err) {
            if (
              err instanceof WorkshopSessionStoreError &&
              err.code === "workshop_session_not_found"
            ) {
              json(res, 404, {
                error: err.message,
                code: err.code,
                sessionId: err.sessionId,
              });
              return true;
            }
            throw err;
          }

          if (wantsStream) {
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-store",
            });
            const resolvedModel = resolveWorkshopModel({
              sessionOverride:
                typeof body.model === "string" || body.model === null
                  ? body.model
                  : undefined,
              settingsDefault: settingsDefault ?? null,
            });
            const writeFrame = async (frame: unknown): Promise<void> => {
              if (req.aborted || res.writableEnded || res.destroyed) return;
              const line = `${JSON.stringify(frame)}\n`;
              if (!res.write(line)) {
                await new Promise<void>((resolve) => {
                  const onDrain = () => {
                    cleanup();
                    resolve();
                  };
                  const onAbort = () => {
                    cleanup();
                    if (!res.writableEnded && !res.destroyed) {
                      res.destroy();
                    }
                    resolve();
                  };
                  const cleanup = () => {
                    res.off("drain", onDrain);
                    req.off("aborted", onAbort);
                    req.off("close", onAbort);
                    res.off("close", onAbort);
                    res.off("error", onAbort);
                  };
                  res.once("drain", onDrain);
                  req.once("aborted", onAbort);
                  req.once("close", onAbort);
                  res.once("close", onAbort);
                  res.once("error", onAbort);
                  if (req.aborted || res.writableEnded || res.destroyed) {
                    onAbort();
                  }
                });
              }
            };
            let streamedDelta = false;
            let writeChain: Promise<void> = Promise.resolve();
            const enqueueFrame = (frame: unknown): void => {
              writeChain = writeChain.then(() => writeFrame(frame));
            };
            try {
              const turn = await runWorkshopChatTurn({
                ...chatTurnBase,
                onDelta: (text) => {
                  streamedDelta = true;
                  enqueueFrame({ type: "delta", text });
                },
              });
              await writeChain;
              for (const frame of iterateWorkshopChatStreamFrames(turn, {
                chunkAssistantText: !streamedDelta,
              })) {
                await writeFrame(frame);
              }
              if (!res.writableEnded && !res.destroyed) {
                res.end();
              }
            } catch (err) {
              await writeChain.catch(() => undefined);
              const message = err instanceof Error ? err.message : String(err);
              const errorEvent = { type: "error" as const, message };
              await writeFrame({
                type: "event",
                event: errorEvent,
              });
              await writeFrame({
                type: "done",
                sessionId: body.sessionId,
                events: [errorEvent],
                draft: draftParsed,
                pending: null,
                autoApply: false,
                model: resolvedModel,
              });
              if (!res.writableEnded && !res.destroyed) {
                res.end();
              }
            }
            return true;
          }

          let turn;
          try {
            turn = await runWorkshopChatTurn(chatTurnBase);
          } catch (err) {
            if (
              err instanceof WorkshopSessionStoreError &&
              err.code === "workshop_session_not_found"
            ) {
              json(res, 404, {
                error: err.message,
                code: err.code,
                sessionId: err.sessionId,
              });
              return true;
            }
            json(res, 400, {
              error: err instanceof Error ? err.message : String(err),
            });
            return true;
          }

          json(res, 200, turn);
          return true;
        }

        if (
          method === "POST" &&
          pathname === "/api/workshop/disk-change"
        ) {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (!isPlainObject(body)) {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          if (typeof body.pipelinePath !== "string" || !body.pipelinePath.trim()) {
            json(res, 400, { error: "pipelinePath is required" });
            return true;
          }
          const draftParsed = parseDraftPackageBody(body);
          if ("ok" in draftParsed) {
            json(res, draftParsed.status, { error: draftParsed.error });
            return true;
          }
          const writeRoot =
            typeof body.project_root === "string"
              ? body.project_root
              : undefined;
          let projectRoot: string;
          try {
            const { wireRoot } = await resolveCatalogStartInput(
              { store, bootCwd: cwd },
              writeRoot,
            );
            const ctx = await resolveStageflowContext(wireRoot.path);
            projectRoot = ctx.projectRoot;
          } catch (err) {
            if (err instanceof CatalogPathError) {
              json(
                res,
                err.code === "catalog_root_read_only" ? 403 : 400,
                catalogPathErrorBody(err),
              );
              return true;
            }
            throw err;
          }
          const relativePaths = draftPackageDiskRelativePaths({
            pipelinePath: body.pipelinePath,
            draft: draftParsed,
            taskPath:
              typeof body.taskPath === "string" ? body.taskPath : null,
          });
          const current = fingerprintPackageFiles(projectRoot, relativePaths);
          const baseline =
            isPlainObject(body.baseline) &&
            Object.values(body.baseline).every((v) => typeof v === "string")
              ? (body.baseline as Record<string, string>)
              : null;
          const detection = detectDiskChange({ baseline, current });
          json(res, 200, {
            fingerprints: current,
            changed: detection.changed,
            changedPaths: detection.changedPaths,
          });
          return true;
        }

        if (method === "GET" && pathname === "/api/models") {
          const filter = url.searchParams.get("project_root") ?? undefined;
          const result = await listModelsMultiProject({
            store,
            bootCwd: cwd,
            projectRootFilter: filter,
          });
          if (
            result.root_errors.some((e) => e.code === "unknown_project_root") &&
            result.items.length === 0
          ) {
            json(res, 400, {
              error: result.root_errors[0]!.message,
              code: "unknown_project_root",
              root_errors: result.root_errors,
            });
            return true;
          }
          json(res, 200, {
            models: result.models,
            entries: result.items,
            root_errors: result.root_errors,
          });
          return true;
        }

        if (
          await handleProviderRoutes(req, res, {
            cwd,
            readJsonBody,
            json,
            providerAuthContext,
          })
        ) {
          return true;
        }

        if (
          await handleProjectMcpRoutes(req, res, {
            projectRoot: rootDir,
            json,
          })
        ) {
          return true;
        }

        if (method === "GET" && pathname === "/api/skills") {
          json(res, 200, await listSkills({ cwd, agentDir }));
          return true;
        }

        if (method === "GET" && pathname === "/api/extensions") {
          json(res, 200, await listExtensions({ cwd, agentDir }));
          return true;
        }

        if (method === "GET" && pathname === "/api/health") {
          await handleApiHealth(req, res, boot);
          return true;
        }

        if (method === "GET" && pathname === "/api/settings") {
          const health = manager.getHealth();
          const credential = getCredentialSourceSettings(cwd);
          const factory = readFactorySettings(cwd);
          json(res, 200, {
            maxConcurrent: health.maxConcurrent,
            ...credential,
            ...(factory.workshopModel !== undefined
              ? { workshopModel: factory.workshopModel }
              : {}),
          });
          return true;
        }

        if (method === "POST" && pathname === "/api/settings") {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return true;
          }
          const record =
            body !== null && typeof body === "object" && !Array.isArray(body)
              ? (body as Record<string, unknown>)
              : {};
          const hasMax = Object.prototype.hasOwnProperty.call(
            record,
            "maxConcurrent",
          );
          const hasCredentialSource = Object.prototype.hasOwnProperty.call(
            record,
            "credentialSource",
          );
          const hasWorkshopModel = Object.prototype.hasOwnProperty.call(
            record,
            "workshopModel",
          );
          if (!hasMax && !hasCredentialSource && !hasWorkshopModel) {
            json(res, 400, {
              error:
                "maxConcurrent, credentialSource, or workshopModel is required",
            });
            return true;
          }

          let health = manager.getHealth();
          if (hasMax) {
            const n = parseSlotCount(record.maxConcurrent);
            if (n === undefined) {
              json(res, 400, { error: INVALID_SLOT_COUNT_MESSAGE });
              return true;
            }
            health = manager.setMaxConcurrent(n);
          }

          let credential = getCredentialSourceSettings(cwd);
          if (hasCredentialSource) {
            try {
              credential = setCredentialSource(cwd, record.credentialSource);
            } catch (err) {
              const mapped = mapProviderAuthError(err);
              json(res, mapped.status, mapped.body);
              return true;
            }
          }

          let workshopModel = readFactorySettings(cwd).workshopModel;
          if (hasWorkshopModel) {
            const parsed = parseWorkshopModelSetting(record.workshopModel);
            if (parsed === undefined) {
              json(res, 400, { error: INVALID_WORKSHOP_MODEL_MESSAGE });
              return true;
            }
            writeFactorySettings(cwd, { workshopModel: parsed });
            workshopModel = parsed;
          }

          json(res, 200, {
            ...health,
            ...credential,
            ...(workshopModel !== undefined ? { workshopModel } : {}),
          });
          return true;
        }

        if (method === "GET" && uiDistDir !== undefined) {
          const served = await serveStatic(res, uiDistDir, pathname);
          if (served) return true;
          json(res, 404, {
            error: "UI not built. Run npm run ui:build, or use Vite dev proxy.",
          });
          return true;
        }

        json(res, 404, { error: "Not found" });
        return true;
      } catch (err) {
        if (!res.headersSent) {
          json(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }
      }
  };
}

export async function startUiServer(
  options: UiServerOptions,
): Promise<HttpHostEnvelope & { shutdown: ShutdownController }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const uiDistDir = options.uiDistDir ?? defaultUiDistDir();
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);
  const { cwd, agentDir, rootDir } = boot;
  const providerAuthContext = boot.providerAuthContext;
  const allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = options.controlTokens ?? loadControlTokens();

  let shutdown: ShutdownController | undefined;
  const routes =
    boot.serveBlocked !== undefined ||
    boot.manager === undefined ||
    boot.store === undefined
      ? async () => false
      : createOperatorRoutes({
          manager: boot.manager,
          store: boot.store,
          cwd,
          agentDir,
          rootDir,
          providerAuthContext,
          uiDistDir,
          allowedHosts,
          controlTokens,
          getShutdown: () => shutdown,
          ...(options.workshopOperatorHost
            ? { workshopOperatorHost: options.workshopOperatorHost }
            : {}),
        });
  const envelope = await createHttpHost({
    boot,
    host,
    port,
    allowedHosts,
    controlTokens,
    routes,
  });
  shutdown = installShutdownController({
    server: envelope.server,
    host: makeDrainableHostFromOptional(envelope.manager, envelope.store),
  });
  envelope.server.on("close", () => {
    shutdown?.uninstall();
  });
  return { ...envelope, shutdown };
}

export { DEFAULT_PORT };
