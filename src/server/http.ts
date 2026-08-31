import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import type { AgentPort } from "../agent/port.js";
import {
  getCredentialSourceSettings,
  setCredentialSource,
  type ProviderAuthContext,
} from "../agent/providerAuth.js";
import {
  handleProviderRoutes,
  providerAuthErrorBody,
} from "./providerRoutes.js";
import { createPipeline, parseCreatePipelineBody } from "../config/createPipeline.js";
import { createStage, parseCreateStageBody } from "../config/createStage.js";
import { browseCatalog } from "../config/browseCatalog.js";
import { listExtensions } from "../config/listExtensions.js";
import { listSkills } from "../config/listSkills.js";
import { readRunArtifact } from "../mcp/readArtifact.js";
import { handleMcpHttpRequest } from "../mcp/server.js";
import { createRunStore, type RunStoreKind } from "../runstore/createStore.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { RunStore } from "../runstore/port.js";
import {
  RunManager,
  type AbandonStageResult,
  type RetryStageResult,
  type StartRunResult,
} from "../runtime/runManager.js";
import {
  INVALID_SLOT_COUNT_MESSAGE,
  parseSlotCount,
} from "../runtime/settingsFile.js";
import { isTaskFile } from "../runtime/taskInput.js";
import { parseAskOperatorAnswer } from "../tools/askOperator.js";
import type { TaskFile } from "../types/task.js";

const DEFAULT_PORT = 3847;

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
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function startFailureBody(result: Extract<StartRunResult, { ok: false }>) {
  const { ok: _ok, status: _status, reason, ...rest } = result;
  return { error: reason, ...rest };
}

function inferRetryStageErrorCode(reason: string): string | undefined {
  if (/retry already in progress/i.test(reason)) return "retry_in_progress";
  if (/waiting for input/i.test(reason)) return "hitl_not_retriable";
  if (/already has active orchestration/i.test(reason)) return "run_not_retryable";
  if (/run is not failed/i.test(reason)) return "run_not_retryable";
  if (/stage is not failed/i.test(reason)) return "stage_not_failed";
  return undefined;
}

function retryStageFailureBody(
  result: Extract<RetryStageResult, { ok: false }>,
) {
  const { ok: _ok, status: _status, reason, ...rest } = result;
  const code = inferRetryStageErrorCode(reason);
  return { error: reason, ...(code ? { code } : {}), ...rest };
}

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

function isMutatingApi(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return (
    pathname === "/api/runs" ||
    pathname === "/api/settings" ||
    pathname === "/api/stages" ||
    pathname === "/api/pipelines" ||
    /^\/api\/runs\/[^/]+\/rerun$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/answer$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/retry$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/stages\/[^/]+\/abandon$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/answer$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/login\/[^/]+\/cancel$/.test(pathname) ||
    /^\/api\/providers\/[^/]+\/logout$/.test(pathname)
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

/** Login/logout require a non-empty loopback Origin (stricter than other mutating APIs). */
function assertCredentialMutatingOrigin(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    json(res, 403, { error: "Origin required" });
    return false;
  }
  try {
    const originHost = new URL(origin).hostname;
    if (!isLoopbackHostname(originHost)) {
      json(res, 403, { error: "Forbidden origin" });
      return false;
    }
  } catch {
    json(res, 403, { error: "Forbidden origin" });
    return false;
  }
  return true;
}

function hostnameFromHostHeader(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(1, end);
  }
  const colon = hostHeader.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(hostHeader.slice(colon + 1))) {
    return hostHeader.slice(0, colon);
  }
  return hostHeader;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** REST-friendly Host/Origin gate (plain JSON 403). Absent Origin is allowed. */
function assertLoopbackHttpAccess(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    json(res, 403, { error: "Forbidden host" });
    return false;
  }
  if (!isLoopbackHostname(hostnameFromHostHeader(hostHeader))) {
    json(res, 403, { error: "Forbidden host" });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      const originHost = new URL(origin).hostname;
      if (!isLoopbackHostname(originHost)) {
        json(res, 403, { error: "Forbidden origin" });
        return false;
      }
    } catch {
      json(res, 403, { error: "Forbidden origin" });
      return false;
    }
  }
  return true;
}

export function defaultUiDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../ui");
}

export async function startUiServer(options: UiServerOptions): Promise<{
  server: Server;
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  manager: RunManager;
  store: RunStore;
}> {
  const invocationCwd = options.cwd ?? process.cwd();
  const ctx = await resolveStageflowContext(invocationCwd);
  const cwd = ctx.invocationCwd;
  const agentDir = options.agentDir ?? getAgentDir();
  const rootDir = options.rootDir ?? ctx.projectRoot;
  const isGitProject =
    options.rootDir !== undefined
      ? findProjectRoot(rootDir) !== null
      : ctx.isGitProject;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const providerAuthContext = options.providerAuthContext;
  const uiDistDir = options.uiDistDir ?? defaultUiDistDir();
  const store =
    options.store ??
    createRunStore({ rootDir, kind: options.storeKind });
  const manager = new RunManager({
    agent: options.agent,
    cwd,
    projectRoot: rootDir,
    isGitProject,
    store,
    maxConcurrent: options.maxConcurrent,
    operatorCatalog: { cwd, agentDir },
  });
  await manager.attachWaitingStages();
  await manager.reconcileOrphanedStages();
  const validateMcpHost = localhostHostValidation();
  const validateMcpOrigin = localhostOriginValidation();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    if (pathname === "/mcp") {
      if (!validateMcpHost(req, res) || !validateMcpOrigin(req, res)) {
        return;
      }
      try {
        await handleMcpHttpRequest(req, res, { manager, store, cwd });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (isMutatingApi(method, pathname)) {
      if (!assertLoopbackHttpAccess(req, res)) {
        return;
      }
      if (
        isCredentialMutatingApi(method, pathname) &&
        !assertCredentialMutatingOrigin(req, res)
      ) {
        return;
      }
    }

    try {
      if (method === "GET" && pathname === "/api/runs") {
        json(res, 200, { runs: await store.listRuns() });
        return;
      }

      const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifact$/);
      if (method === "GET" && artifactMatch) {
        const runId = decodeURIComponent(artifactMatch[1] ?? "");
        const artifactPath = url.searchParams.get("path");
        if (artifactPath === null || artifactPath.trim().length === 0) {
          json(res, 400, { error: "path query parameter is required" });
          return;
        }
        try {
          const content = await readRunArtifact(store, runId, artifactPath);
          textPlain(res, 200, content);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Artifact path denied") {
            json(res, 403, { error: message });
            return;
          }
          const notFound =
            message.startsWith("Run not found") ||
            message.startsWith("Artifact not found") ||
            /no such|not found/i.test(message);
          json(res, notFound ? 404 : 400, { error: message });
        }
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/runs/")) {
        const rest = pathname.slice("/api/runs/".length);
        if (rest && !rest.includes("/")) {
          try {
            json(res, 200, await store.readRun(decodeURIComponent(rest)));
          } catch (err) {
            json(res, 404, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
      }

      if (method === "POST" && pathname === "/api/runs") {
        const body = (await readJsonBody(req)) as {
          task?: string | TaskFile;
          pipeline?: string;
        };
        if (
          typeof body.pipeline !== "string" ||
          !body.pipeline.trim() ||
          body.task === undefined
        ) {
          json(res, 400, { error: "task and pipeline are required" });
          return;
        }
        if (typeof body.task !== "string" && !isTaskFile(body.task)) {
          json(res, 400, {
            error:
              "task must be a path string or TaskFile object (id and goal required)",
          });
          return;
        }
        const result = await manager.startRun({
          task: body.task,
          pipeline: body.pipeline.trim(),
        });
        if (!result.ok) {
          json(res, result.status ?? 500, startFailureBody(result));
          return;
        }
        json(res, 202, { runId: result.runId });
        return;
      }

      if (method === "POST" && pathname.match(/^\/api\/runs\/[^/]+\/rerun$/)) {
        const runId = decodeURIComponent(pathname.split("/")[3] ?? "");
        const result = await manager.rerun(runId);
        if (!result.ok) {
          json(res, result.status ?? 500, startFailureBody(result));
          return;
        }
        json(res, 202, { runId: result.runId });
        return;
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
          return;
        }

        const result = await manager.deliverAnswer(runId, stageId, answer);
        if (!result.ok) {
          json(res, result.status, { error: result.reason });
          return;
        }
        json(res, 202, { ok: true });
        return;
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
          json(res, result.status ?? 500, retryStageFailureBody(result));
          return;
        }
        json(res, 202, {
          runId: result.runId,
          stageId: result.stageId,
          attemptIndex: result.attemptIndex,
        });
        return;
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
          return;
        }
        json(res, 202, {
          ok: true,
          runId: result.runId,
          stageId: result.stageId,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/tasks") {
        const catalog = await browseCatalog(cwd);
        json(res, 200, { tasks: catalog.tasks });
        return;
      }

      if (method === "GET" && pathname === "/api/pipelines") {
        const catalog = await browseCatalog(cwd);
        json(res, 200, { pipelines: catalog.pipelines });
        return;
      }

      if (method === "GET" && pathname === "/api/stages") {
        json(res, 404, {
          error: "Global stage library removed; stages are pipeline-scoped",
        });
        return;
      }

      if (method === "POST" && pathname === "/api/stages") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const parsed = parseCreateStageBody(body);
        if ("ok" in parsed) {
          json(res, parsed.status, { error: parsed.error });
          return;
        }
        const ctx = await resolveStageflowContext(cwd);
        if (!ctx.isGitProject) {
          json(res, 400, { error: "Project root not found; initialize stageflow.yaml in a git repo" });
          return;
        }
        const result = await createStage(ctx.projectRoot, parsed);
        if (!result.ok) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 201, result.stage);
        return;
      }

      if (method === "POST" && pathname === "/api/pipelines") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const parsed = parseCreatePipelineBody(body);
        if ("ok" in parsed) {
          json(res, parsed.status, { error: parsed.error });
          return;
        }
        const ctx = await resolveStageflowContext(cwd);
        if (!ctx.isGitProject) {
          json(res, 400, { error: "Project root not found; initialize stageflow.yaml in a git repo" });
          return;
        }
        const result = await createPipeline(ctx.projectRoot, parsed);
        if (!result.ok) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 201, result.pipeline);
        return;
      }

      if (method === "GET" && pathname === "/api/models") {
        const catalog = await browseCatalog(cwd);
        json(res, 200, { models: catalog.models });
        return;
      }

      if (
        await handleProviderRoutes(req, res, {
          cwd,
          readJsonBody,
          json,
          providerAuthContext,
        })
      ) {
        return;
      }

      if (method === "GET" && pathname === "/api/skills") {
        json(res, 200, await listSkills({ cwd, agentDir }));
        return;
      }

      if (method === "GET" && pathname === "/api/extensions") {
        json(res, 200, await listExtensions({ cwd, agentDir }));
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        json(res, 200, manager.getHealth());
        return;
      }

      if (method === "GET" && pathname === "/api/settings") {
        const health = manager.getHealth();
        const credential = getCredentialSourceSettings(cwd);
        json(res, 200, {
          maxConcurrent: health.maxConcurrent,
          ...credential,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/settings") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
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
          return;
        }

        let health = manager.getHealth();
        if (hasMax) {
          const n = parseSlotCount(record.maxConcurrent);
          if (n === undefined) {
            json(res, 400, { error: INVALID_SLOT_COUNT_MESSAGE });
            return;
          }
          health = manager.setMaxConcurrent(n);
        }

        let credential = getCredentialSourceSettings(cwd);
        if (hasCredentialSource) {
          try {
            credential = setCredentialSource(cwd, record.credentialSource);
          } catch (err) {
            const mapped = providerAuthErrorBody(err);
            json(res, mapped.status, mapped.body);
            return;
          }
        }

        json(res, 200, {
          ...health,
          ...credential,
        });
        return;
      }

      if (method === "GET") {
        const served = await serveStatic(res, uiDistDir, pathname);
        if (served) return;
        json(res, 404, {
          error: "UI not built. Run npm run ui:build, or use Vite dev proxy.",
        });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      if (!res.headersSent) {
        json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const boundPort =
    address && typeof address !== "string" ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  return {
    server,
    port: boundPort,
    host,
    url,
    mcpUrl: `${url}/mcp`,
    manager,
    store,
  };
}

export { DEFAULT_PORT };
