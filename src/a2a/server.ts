import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import {
  AgentCard,
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type Task,
} from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion, type A2ARequestHandler } from "@a2a-js/sdk/server";
import {
  A2AError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { A2aApplicationError } from "./contracts.js";
import { loadPublicationRegistry, type PublicationRegistry } from "./registry.js";
import { createA2aInvocations, type A2aInvocations, type PublicTask } from "./service.js";
import type { A2aStore } from "./store.js";

export const A2A_BODY_LIMIT = 1024 * 1024;

/** Single source of truth for the two sub-routes so the URL builders below and the router in `createA2aHost` can never drift apart. */
const CONTRACT_ROUTE_PREFIX = "/a2a/contracts/";
const ARTIFACT_ROUTE_PREFIX = "/a2a/artifacts/";
function contractUrl(publicUrl: string, publicationId: string): string {
  return publicUrl + CONTRACT_ROUTE_PREFIX + publicationId;
}
function artifactUrl(publicUrl: string, taskId: string, artifactId: string): string {
  return publicUrl + ARTIFACT_ROUTE_PREFIX + taskId + "/" + artifactId;
}

export function publicationCard(registry: PublicationRegistry, caller: string): AgentCard {
  return AgentCard.fromJSON({
    name: "Stageflow",
    description: "Invoke published Stageflow pipelines as A2A capabilities.",
    version: PACKAGE_VERSION,
    supportedInterfaces: [{ url: registry.publicUrl + "/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: true },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: registry.list(caller).map((publication) => ({
      id: publication.id,
      name: publication.name,
      description: publication.description + " Contract: " + contractUrl(registry.publicUrl, publication.id),
      tags: ["pipeline"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    })),
  });
}

function mapState(state: PublicTask["state"]): TaskState {
  switch (state) {
    case "submitted":
      return TaskState.TASK_STATE_SUBMITTED;
    case "working":
      return TaskState.TASK_STATE_WORKING;
    case "input-required":
      return TaskState.TASK_STATE_INPUT_REQUIRED;
    case "completed":
      return TaskState.TASK_STATE_COMPLETED;
    case "failed":
      return TaskState.TASK_STATE_FAILED;
  }
}

function dataPart(value: unknown): Part {
  return { content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" };
}

function urlPart(url: string, filename: string, mediaType: string): Part {
  return { content: { $case: "url", value: url }, metadata: undefined, filename, mediaType };
}

function statusMessage(taskId: string, contextId: string, parts: Part[]): Message {
  return {
    messageId: "status-" + taskId + "-" + Date.now().toString(36),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function toWireTask(publicUrl: string, task: PublicTask): Task {
  const parts: Part[] = [];
  if (task.state === "input-required" && task.questions) {
    parts.push(dataPart({ questions: task.questions }));
  }
  const artifacts: Artifact[] = [];
  if (task.result) {
    if (task.result.payload !== undefined) {
      artifacts.push({
        artifactId: "result",
        name: "result",
        description: task.result.summary,
        parts: [dataPart(task.result.payload)],
        metadata: undefined,
        extensions: [],
      });
    }
    for (const file of task.result.artifacts) {
      artifacts.push({
        artifactId: file.id,
        name: file.name,
        description: "",
        parts: [urlPart(artifactUrl(publicUrl, task.id, file.id), file.name, file.mediaType ?? "application/octet-stream")],
        metadata: undefined,
        extensions: [],
      });
    }
  }
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: mapState(task.state),
      message: parts.length > 0 ? statusMessage(task.id, task.contextId, parts) : undefined,
      timestamp: task.updatedAt,
    },
    artifacts,
    history: [],
    metadata: undefined,
  };
}

function mapApplicationError(err: unknown): never {
  if (err instanceof A2aApplicationError) {
    if (err.category === "not-found") {
      throw new TaskNotFoundError({ message: err.message });
    }
    if (err.category === "busy" || err.category === "export-failed") {
      throw new A2AError({ message: err.message, metadata: { category: err.category } });
    }
    throw new RequestMalformedError({ message: err.message, metadata: { category: err.category } });
  }
  throw err;
}

function realHandler(card: AgentCard, invocations: A2aInvocations, publicUrl: string): A2ARequestHandler {
  const unsupportedStream = async function* (): AsyncGenerator<never> {
    throw new UnsupportedOperationError("Streaming is not enabled");
  };
  const pushUnsupported = async (): Promise<never> => {
    throw new UnsupportedOperationError("Push notifications are not enabled");
  };
  return {
    getAgentCard: async () => card,
    getAuthenticatedExtendedAgentCard: async () => card,
    async sendMessage(params, context) {
      if (!params.message) throw new RequestMalformedError({ message: "A message is required" });
      try {
        const task = await invocations.send({ id: context.user!.userName }, params.message);
        return toWireTask(publicUrl, task);
      } catch (err) {
        return mapApplicationError(err);
      }
    },
    async getTask(params, context) {
      try {
        const task = await invocations.get({ id: context.user!.userName }, params.id);
        return toWireTask(publicUrl, task);
      } catch (err) {
        return mapApplicationError(err);
      }
    },
    async listTasks(params, context) {
      try {
        const tasks = await invocations.list({ id: context.user!.userName }, params.contextId || undefined);
        const size = params.pageSize && params.pageSize > 0 ? Math.min(params.pageSize, 100) : 50;
        const limited = tasks.slice(0, size);
        return { tasks: limited.map((task) => toWireTask(publicUrl, task)), nextPageToken: "", pageSize: limited.length, totalSize: tasks.length };
      } catch (err) {
        return mapApplicationError(err);
      }
    },
    async cancelTask(params, context) {
      try {
        await invocations.get({ id: context.user!.userName }, params.id);
      } catch (err) {
        return mapApplicationError(err);
      }
      throw new TaskNotCancelableError({ message: "Active pipeline cancellation is not available yet" });
    },
    sendMessageStream: unsupportedStream,
    resubscribe: unsupportedStream,
    createTaskPushNotificationConfig: pushUnsupported,
    getTaskPushNotificationConfig: pushUnsupported,
    listTaskPushNotificationConfigs: pushUnsupported,
    deleteTaskPushNotificationConfig: pushUnsupported,
  };
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Authorization" });
  res.end(JSON.stringify(value));
}

async function readBody(req: HttpIncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > A2A_BODY_LIMIT) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type A2aRuntime = {
  manager: RunManager;
  runStore: RunStore;
  rootDir: string;
  /** The SqliteRunStore's own connection to `state.db`, when the caller constructed one via `createRunStoreWithConnection`. */
  connection?: Database.Database;
  /** Shared A2A store when the Host composition root already opened one for delete_run. */
  a2aStore?: A2aStore;
};

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type A2aHost = {
  status: { state: "disabled" | "enabled" | "configuration_error"; configPath?: string };
  handle(req: HttpIncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
  /** Deletes expired terminal tasks/artifacts and message tombstones. A no-op when A2A is not enabled. */
  pruneExpired(now?: Date): Promise<{ removedTasks: number; removedMessages: number }>;
  close(): void;
};

export async function createA2aHost(
  runtime: A2aRuntime,
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<A2aHost> {
  let registry: PublicationRegistry | undefined;
  let invocations: A2aInvocations | undefined;
  const status: A2aHost["status"] = { state: "disabled" };
  if (configPath) {
    status.configPath = configPath;
    try {
      registry = await loadPublicationRegistry(configPath, env);
      status.configPath = registry.configPath;
      status.state = "enabled";
      invocations = createA2aInvocations(
        registry,
        runtime.manager,
        runtime.runStore,
        runtime.rootDir,
        runtime.connection,
        undefined,
        runtime.a2aStore,
      );
    } catch {
      status.state = "configuration_error";
    }
  }
  const sweep = invocations
    ? setInterval(() => {
        invocations!.pruneExpired().catch(() => undefined);
      }, RETENTION_SWEEP_INTERVAL_MS).unref()
    : undefined;
  return {
    status,
    async pruneExpired(now) {
      return (await invocations?.pruneExpired(now)) ?? { removedTasks: 0, removedMessages: 0 };
    },
    close() {
      if (sweep) clearInterval(sweep);
      invocations?.close();
    },
    async handle(req, res, pathname) {
      const isRoute =
        pathname === "/a2a" ||
        pathname === "/.well-known/agent-card.json" ||
        pathname.startsWith(CONTRACT_ROUTE_PREFIX) ||
        pathname.startsWith(ARTIFACT_ROUTE_PREFIX);
      if (!isRoute) return false;
      if (!registry || !invocations) {
        respond(res, status.state === "disabled" ? 404 : 503, { error: "A2A unavailable" });
        return true;
      }
      const caller = registry.authenticate(req.headers.authorization);
      if (!caller) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="stageflow-a2a"');
        respond(res, 401, { error: "Authentication required" });
        return true;
      }
      if (pathname.startsWith(ARTIFACT_ROUTE_PREFIX)) {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          respond(res, 405, { error: "Method not allowed" });
          return true;
        }
        const segments = pathname.slice(ARTIFACT_ROUTE_PREFIX.length).split("/");
        if (segments.length !== 2) {
          respond(res, 404, { error: "Artifact not found" });
          return true;
        }
        try {
          const artifact = await invocations.readArtifact({ id: caller }, segments[0], segments[1]);
          res.writeHead(200, {
            "Content-Type": artifact.mediaType ?? "application/octet-stream",
            "Content-Length": artifact.bytes.length,
            "Cache-Control": "no-store",
            "Vary": "Authorization",
          });
          res.end(artifact.bytes);
        } catch {
          respond(res, 404, { error: "Artifact not found" });
        }
        return true;
      }
      const card = publicationCard(registry, caller);
      if (pathname !== "/a2a") {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          respond(res, 405, { error: "Method not allowed" });
        } else if (pathname === "/.well-known/agent-card.json") {
          respond(res, 200, AgentCard.toJSON(card));
        } else {
          const publication = registry.get(caller, pathname.slice(CONTRACT_ROUTE_PREFIX.length));
          if (!publication) respond(res, 404, { error: "Contract not found" });
          else
            respond(res, 200, {
              contractVersion: 1,
              capability: publication.id,
              revision: publication.revision,
              executionEnabled: true,
              inputSchema: publication.inputSchema,
              outputSchema: publication.outputSchema,
              artifacts: publication.results.artifacts,
            });
        }
        return true;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        respond(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        respond(res, 415, { error: "Expected application/json" });
        return true;
      }
      if (Number(req.headers["content-length"]) > A2A_BODY_LIMIT) {
        respond(res, 413, { error: "Request too large" });
        return true;
      }
      const version = req.headers["a2a-version"];
      try {
        validateVersion(typeof version === "string" ? version : "0.3", card, "JSONRPC");
      } catch (error) {
        respond(res, 400, { jsonrpc: "2.0", id: null, error: JsonRpcTransportHandler.mapToJSONRPCError(error) });
        return true;
      }
      req.setTimeout(30_000, () => req.destroy());
      try {
        const body = await readBody(req);
        const context = new ServerCallContext({ user: { isAuthenticated: true, userName: caller }, requestedVersion: "1.0" });
        const result = await new JsonRpcTransportHandler(realHandler(card, invocations, registry.publicUrl)).handle(body, context);
        respond(res, 200, result);
      } catch (error) {
        if (!res.destroyed) respond(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, { error: "Invalid request body" });
      } finally {
        req.setTimeout(0);
      }
      return true;
    },
  };
}
