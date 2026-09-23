import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, access } from "node:fs/promises";
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
} from "../config/catalogRelativePath.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
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
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import type { RunStore } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
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
  parseSlotCount,
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

export function isMutatingApi(method: string, pathname: string): boolean {
  if (method === "DELETE") {
    return /^\/api\/runs\/[^/]+$/.test(pathname);
  }
  if (method !== "POST") return false;
  return (
    pathname === "/api/runs" ||
    pathname === "/api/runs/gc" ||
    pathname === "/api/settings" ||
    pathname === "/api/stages" ||
    pathname === "/api/pipelines" ||
    /^\/api\/runs\/[^/]+\/rerun$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/answer$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/feedback-decision$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/retry$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/resume$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/recovery$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/recovery\/stop$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/abandon$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/cancel$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/answer$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/cancel$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/logout$/.test(pathname) ||
    /^\/api\/project-mcp\/[^/]+\/probe$/.test(pathname)
  );
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
  const { manager, store, cwd, agentDir, rootDir, providerAuthContext, uiDistDir } = deps;
  const allowedHosts = deps.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = deps.controlTokens ?? loadControlTokens();
  return async ({ req, res, url, pathname, method, boot }) => {
      if (pathname.startsWith("/api/")) {
        if (
          !assertAllowedHttpAccess(allowedHosts, req, res, {
            requireOrigin: isCredentialMutatingApi(method, pathname),
          })
        ) {
          return true;
        }
        const scope = requiredScopeFor(method, pathname);
        if (scope !== null && !enforceBearerAuth(controlTokens, req, res, scope)) {
          return true;
        }
      }

      try {
        if (method === "GET" && pathname === "/api/runs") {
          json(res, 200, { runs: await store.listRuns() });
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

        if (method === "GET" && pathname.startsWith("/api/runs/")) {
          const rest = pathname.slice("/api/runs/".length);
          if (rest && !rest.includes("/")) {
            try {
              json(res, 200, await store.readRun(decodeURIComponent(rest)));
            } catch (err) {
              const mapped = mapStoreLookupError(err, { policy: "run" });
              json(res, 404, { error: mapped.error });
            }
            return true;
          }
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
          const roots = await resolveCatalogRoots({ store, bootCwd: cwd });
          let pipelinePath = typed.pipeline.trim();
          let taskInput: string | TaskFile = typed.task;
          try {
            pipelinePath = resolveCatalogRelativePath({
              inputPath: pipelinePath,
              projectRoot: typed.project_root,
              roots,
              fieldName: "pipeline",
            }).absolutePath;
            if (typeof typed.task === "string") {
              taskInput = resolveCatalogRelativePath({
                inputPath: typed.task,
                projectRoot: typed.project_root,
                roots,
                fieldName: "task",
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
          try {
            result = await manager.startRun({
              task: taskInput,
              pipeline: pipelinePath,
              ...(typed.checkoutOverride !== undefined
                ? { checkoutOverride: typed.checkoutOverride }
                : {}),
              ...(typed.skipGates !== undefined ? { skipGates: typed.skipGates } : {}),
              ...(typed.gitSha !== undefined ? { gitSha: typed.gitSha } : {}),
              ...(typed.ciPrUrl !== undefined ? { ciPrUrl: typed.ciPrUrl } : {}),
              ...(typed.ciJobUrl !== undefined ? { ciJobUrl: typed.ciJobUrl } : {}),
            });
          } catch (err) {
            if (err instanceof PipelineValidationError) {
              json(res, 400, {
                error: "Pipeline validation failed",
                validation: err.result,
              });
              return true;
            }
            throw err;
          }
          if (!result.ok) {
            json(res, result.status ?? 500, mapStartFailure(result));
            return true;
          }
          json(res, 202, {
            runId: result.runId,
            ...(result.queued === true
              ? { queued: true, queuePosition: result.queuePosition }
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
          const result = await manager.rerun(
            runId,
            body.pinned !== undefined ? { pinned: body.pinned } : undefined,
          );
          if (!result.ok) {
            json(res, result.status ?? 500, mapStartFailure(result));
            return true;
          }
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
          const parsed = parseCreateStageBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(cwd);
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
          if (writeRoot !== undefined) {
            const roots = await resolveCatalogRoots({ store, bootCwd: cwd });
            const match = roots.find((r) => r.project_root === writeRoot);
            if (match?.read_only) {
              json(res, 403, {
                error: `Catalog root ${writeRoot} is read-only`,
                code: "catalog_root_read_only",
              });
              return true;
            }
          }
          const parsed = parseCreatePipelineBody(body);
          if ("ok" in parsed) {
            json(res, parsed.status, { error: parsed.error });
            return true;
          }
          const ctx = await resolveStageflowContext(cwd);
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
          json(res, 200, {
            maxConcurrent: health.maxConcurrent,
            ...credential,
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
          if (!hasMax && !hasCredentialSource) {
            json(res, 400, {
              error: "maxConcurrent or credentialSource is required",
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

          json(res, 200, {
            ...health,
            ...credential,
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
  };
}

export async function startUiServer(
  options: UiServerOptions,
): Promise<HttpHostEnvelope> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const uiDistDir = options.uiDistDir ?? defaultUiDistDir();
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);
  const { manager, store, cwd, agentDir, rootDir } = boot;
  const providerAuthContext = boot.providerAuthContext;
  const allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = options.controlTokens ?? loadControlTokens();

  return createHttpHost({
    boot,
    host,
    port,
    allowedHosts,
    controlTokens,
    routes: createOperatorRoutes({
      manager,
      store,
      cwd,
      agentDir,
      rootDir,
      providerAuthContext,
      uiDistDir,
      allowedHosts,
      controlTokens,
    }),
  });
}

export { DEFAULT_PORT };
