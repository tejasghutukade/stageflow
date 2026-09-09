import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  StageMcpError,
  resolveStageMcpServers,
  type ResolvedMcpServerConfig,
} from "../config/resolveStageMcpServers.js";
import * as piIsolatedMcp from "./piIsolatedMcp.js";
import type { IsolatedMcpAttach } from "./piIsolatedMcp.js";

export const PROJECT_MCP_PROBE_TIMEOUT_MS = 30_000;

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export type ProjectMcpProbeStatus =
  | "connected"
  | "needs_auth"
  | "connect_failed"
  | "unresolved_var"
  | "invalid_config"
  | "missing_catalog"
  | "cancelled";

export type ProjectMcpProbeResult = {
  name: string;
  status: ProjectMcpProbeStatus;
  error?: string;
};

export type ProbeProjectMcpServerOptions = {
  projectRoot: string;
  name: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function collectInterpolatedSecrets(entry: ResolvedMcpServerConfig): string[] {
  const secrets: string[] = [];
  for (const field of ["env", "headers"] as const) {
    const value = entry[field];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    for (const item of Object.values(value)) {
      if (typeof item === "string" && item.length > 0) {
        secrets.push(item);
      }
    }
  }
  return secrets;
}

function catalogErrorResult(
  name: string,
  err: unknown,
): ProjectMcpProbeResult | undefined {
  if (!(err instanceof StageMcpError)) return undefined;
  if (err.code === "unresolved_var") {
    return { name, status: "unresolved_var", error: err.message };
  }
  if (err.code === "missing_catalog") {
    return { name, status: "missing_catalog" };
  }
  if (
    err.code === "invalid_config" ||
    err.code === "reserved_name" ||
    err.code === "unknown_server"
  ) {
    return { name, status: "invalid_config" };
  }
  return undefined;
}

function asStatusServers(
  data: unknown,
): ReadonlyArray<{ name: string; status: string }> | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return undefined;
  const parsed: Array<{ name: string; status: string }> = [];
  for (const entry of servers) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    const status = (entry as { status?: unknown }).status;
    if (typeof name === "string" && typeof status === "string") {
      parsed.push({ name, status });
    }
  }
  return parsed;
}

function mapRuntimeStatus(
  status: string,
): "connected" | "needs_auth" | "connect_failed" | undefined {
  if (status === "connected" || status === "cached") return "connected";
  if (status === "needs-auth") return "needs_auth";
  if (status === "failed" || status === "disabled") return "connect_failed";
  return undefined;
}

function createProbeExtensionApi(eventBus: EventBus): {
  api: ExtensionAPI;
  emitSessionStart: (cwd: string) => void;
  emitSessionShutdown: () => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = {
    events: eventBus,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    registerMarkdownTransformer() {},
    registerEntryRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    getAllTools() {
      return [];
    },
  };

  async function emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(...args);
    }
  }

  return {
    api: api as unknown as ExtensionAPI,
    emitSessionStart(cwd: string) {
      void emit("session_start", {}, { mode: "print", hasUI: false, cwd });
    },
    emitSessionShutdown() {
      return emit("session_shutdown", {});
    },
  };
}

function instantiateProbeFactories(
  attached: IsolatedMcpAttach,
  projectRoot: string,
): () => Promise<void> {
  const factories = attached.extensionFactories ?? [];
  const eventBus = attached.eventBus;
  if (factories.length === 0 || eventBus === undefined) {
    return async () => {};
  }
  const probeApi = createProbeExtensionApi(eventBus);
  for (const ext of factories) {
    const factory = typeof ext === "function" ? ext : ext.factory;
    factory(probeApi.api);
  }
  probeApi.emitSessionStart(projectRoot);
  return () => probeApi.emitSessionShutdown();
}

function mapConnectingError(
  err: unknown,
  aborted: boolean,
):
  | { kind: "cancelled" }
  | { kind: "mapped"; status: "needs_auth" | "connect_failed"; error?: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (aborted || /cancelled/i.test(message)) {
    return { kind: "cancelled" };
  }
  if (/needs-auth/.test(message)) {
    return { kind: "mapped", status: "needs_auth" };
  }
  return {
    kind: "mapped",
    status: "connect_failed",
    error: message.length > 0 ? message : undefined,
  };
}

async function waitForProbeStatus(
  eventBus: EventBus,
  serverName: string,
  connecting: Promise<void> | undefined,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<
  | { kind: "mapped"; status: "connected" | "needs_auth" | "connect_failed"; error?: string }
  | { kind: "cancelled" }
> {
  if (options.signal?.aborted) {
    return { kind: "cancelled" };
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      result:
        | { kind: "mapped"; status: "connected" | "needs_auth" | "connect_failed"; error?: string }
        | { kind: "cancelled" },
    ) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ kind: "cancelled" });

    const consider = (data: unknown) => {
      const servers = asStatusServers(data);
      if (servers === undefined) return;
      const entry = servers.find((server) => server.name === serverName);
      if (entry === undefined) return;
      const mapped = mapRuntimeStatus(entry.status);
      if (mapped === undefined) return;
      if (mapped === "connect_failed") {
        finish({
          kind: "mapped",
          status: "connect_failed",
          error: `MCP server "${serverName}" failed to connect (status: ${entry.status})`,
        });
        return;
      }
      finish({ kind: "mapped", status: mapped });
    };

    const handler = (data: unknown) => consider(data);
    const maybeUnsub = eventBus.on(MCP_STATUS_EVENT, handler);
    unsubscribe = typeof maybeUnsub === "function" ? maybeUnsub : undefined;

    options.signal?.addEventListener("abort", onAbort, { once: true });

    void (connecting ?? Promise.resolve()).then(
      () => finish({ kind: "mapped", status: "connected" }),
      (err: unknown) => finish(mapConnectingError(err, options.signal?.aborted === true)),
    );

    timer = setTimeout(() => {
      finish({
        kind: "mapped",
        status: "connect_failed",
        error: `MCP server "${serverName}" failed to connect (status: timed out)`,
      });
    }, options.timeoutMs);
  });
}

export async function probeProjectMcpServer(
  options: ProbeProjectMcpServerOptions,
): Promise<ProjectMcpProbeResult> {
  const name = options.name;
  const timeoutMs = options.timeoutMs ?? PROJECT_MCP_PROBE_TIMEOUT_MS;
  const env = options.env ?? process.env;

  if (options.signal?.aborted) {
    return { name, status: "cancelled" };
  }

  let snapshot;
  try {
    snapshot = await resolveStageMcpServers({
      projectRoot: options.projectRoot,
      allowlist: [name],
      env,
    });
  } catch (err) {
    return (
      catalogErrorResult(name, err) ?? {
        name,
        status: "invalid_config",
      }
    );
  }

  const resolved = snapshot[name];
  if (resolved === undefined) {
    return { name, status: "invalid_config" };
  }

  const secrets = collectInterpolatedSecrets(resolved);
  let attached: IsolatedMcpAttach | undefined;
  let shutdownFactories: (() => Promise<void>) | undefined;

  const dispose = async () => {
    if (attached?.connecting !== undefined) {
      void attached.connecting.then(() => undefined, () => undefined);
    }
    attached?.cancel?.();
    if (shutdownFactories !== undefined) {
      const stop = shutdownFactories;
      shutdownFactories = undefined;
      await stop();
    }
  };

  try {
    if (options.signal?.aborted) {
      return { name, status: "cancelled" };
    }

    attached = await piIsolatedMcp.attachIsolatedMcp(snapshot, {
      timeoutMs,
      lifecycle: "eager",
    });
    if (attached.eventBus === undefined) {
      return { name, status: "invalid_config" };
    }

    shutdownFactories = instantiateProbeFactories(
      attached,
      options.projectRoot,
    );

    const waited = await waitForProbeStatus(
      attached.eventBus,
      name,
      attached.connecting,
      { timeoutMs, signal: options.signal },
    );

    if (waited.kind === "cancelled") {
      return { name, status: "cancelled" };
    }
    if (waited.status === "connect_failed") {
      return {
        name,
        status: "connect_failed",
        ...(waited.error !== undefined
          ? { error: scrub(waited.error, secrets) }
          : {}),
      };
    }
    return { name, status: waited.status };
  } catch (err) {
    if (options.signal?.aborted) {
      return { name, status: "cancelled" };
    }
    const catalog = catalogErrorResult(name, err);
    if (catalog) return catalog;
    const message = err instanceof Error ? err.message : String(err);
    if (/cancelled/i.test(message)) {
      return { name, status: "cancelled" };
    }
    return {
      name,
      status: "connect_failed",
      error: scrub(message, secrets),
    };
  } finally {
    await dispose();
  }
}
