import {
  type EventBus,
  type ExtensionFactory,
  type InlineExtension,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import {
  StageMcpError,
  type ResolvedMcpServers,
} from "../config/resolveStageMcpServers.js";

export const STAGEFLOW_PI_MCP_EXTENSION_NAME = "stageflow-mcp";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const DEFAULT_ISOLATED_MCP_CONNECT_TIMEOUT_MS = 5_000;
const STATUS_POLL_MS = 50;
const PI_MCP_ADAPTER_SPEC: string = "pi-mcp-adapter";

type IsolatedMcpSettings = {
  directTools: true;
  elicitation: false;
  hostConfigDiscovery: "off";
};

type IsolatedMcpServerEntry = Record<string, unknown> & {
  lifecycle: "lazy";
  directTools: true;
};

type IsolatedMcpConfig = {
  mcpServers: Record<string, IsolatedMcpServerEntry>;
  settings: IsolatedMcpSettings;
};

type CreateMcpAdapter = (options: {
  config: IsolatedMcpConfig;
}) => ExtensionFactory;

type IsolatedMcpServerRuntimeStatus =
  | "connected"
  | "cached"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

type IsolatedMcpStatusServer = {
  name: string;
  status: IsolatedMcpServerRuntimeStatus;
};

type IsolatedMcpStatusSnapshot = {
  servers: ReadonlyArray<IsolatedMcpStatusServer>;
};

type IsolatedMcpStatusSource = {
  read?: () => IsolatedMcpStatusSnapshot | undefined;
  subscribe?: (listener: (snapshot: IsolatedMcpStatusSnapshot) => void) => () => void;
};

type IsolatedMcpStatusEvents = {
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
  off?(channel: string, handler: (data: unknown) => void): void;
};

export type IsolatedMcpAttachOptions = {
  timeoutMs?: number;
};

export type IsolatedMcpAttach = {
  extensionFactories: InlineExtension[] | undefined;
  eventBus: EventBus | undefined;
  connecting: Promise<void> | undefined;
  cancel?: () => void;
};

const ISOLATED_MCP_SETTINGS: IsolatedMcpSettings = {
  directTools: true,
  elicitation: false,
  hostConfigDiscovery: "off",
};

const SUCCESS_STATUSES = new Set<IsolatedMcpServerRuntimeStatus>([
  "connected",
  "cached",
]);

const FAILURE_STATUSES = new Set<IsolatedMcpServerRuntimeStatus>([
  "failed",
  "needs-auth",
  "disabled",
]);

const EMPTY_ATTACH: IsolatedMcpAttach = {
  extensionFactories: undefined,
  eventBus: undefined,
  connecting: undefined,
};

let cachedCreateMcpAdapter: CreateMcpAdapter | undefined;

function toIsolatedMcpConfig(snapshot: ResolvedMcpServers): IsolatedMcpConfig {
  const mcpServers: Record<string, IsolatedMcpServerEntry> = {};
  for (const [name, entry] of Object.entries(snapshot)) {
    const isolated: IsolatedMcpServerEntry = {
      ...entry,
      lifecycle: "lazy",
      directTools: true,
    };
    if (typeof entry.cwd === "string") {
      isolated.cwd = entry.cwd;
    }
    mcpServers[name] = isolated;
  }
  return {
    mcpServers,
    settings: { ...ISOLATED_MCP_SETTINGS },
  };
}

async function loadCreateMcpAdapter(): Promise<CreateMcpAdapter> {
  if (cachedCreateMcpAdapter !== undefined) {
    return cachedCreateMcpAdapter;
  }
  try {
    const mod = (await import(PI_MCP_ADAPTER_SPEC)) as {
      createMcpAdapter: CreateMcpAdapter;
    };
    if (typeof mod.createMcpAdapter === "function") {
      cachedCreateMcpAdapter = mod.createMcpAdapter;
      return cachedCreateMcpAdapter;
    }
  } catch {
    // Node does not type-strip .ts under node_modules.
  }
  const { createJiti } = await import("jiti/static");
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(PI_MCP_ADAPTER_SPEC)) as {
    createMcpAdapter: CreateMcpAdapter;
  };
  cachedCreateMcpAdapter = mod.createMcpAdapter;
  return cachedCreateMcpAdapter;
}

function isRuntimeStatus(value: string): value is IsolatedMcpServerRuntimeStatus {
  return (
    value === "connected" ||
    value === "cached" ||
    value === "failed" ||
    value === "needs-auth" ||
    value === "not-connected" ||
    value === "disabled"
  );
}

function asIsolatedMcpStatusSnapshot(
  data: unknown,
): IsolatedMcpStatusSnapshot | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return undefined;
  const parsed: IsolatedMcpStatusServer[] = [];
  for (const entry of servers) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    const status = (entry as { status?: unknown }).status;
    if (typeof name !== "string" || typeof status !== "string") continue;
    if (!isRuntimeStatus(status)) continue;
    parsed.push({ name, status });
  }
  return { servers: parsed };
}

function mcpStatusSourceFromEvents(
  events: IsolatedMcpStatusEvents,
): IsolatedMcpStatusSource {
  return {
    subscribe(listener) {
      const handler = (data: unknown) => {
        const snapshot = asIsolatedMcpStatusSnapshot(data);
        if (snapshot) listener(snapshot);
      };
      const unsubscribe = events.on(MCP_STATUS_EVENT, handler);
      if (typeof unsubscribe === "function") return unsubscribe;
      return () => {
        events.off?.(MCP_STATUS_EVENT, handler);
      };
    },
  };
}

function connectFailed(name: string, status: string): StageMcpError {
  return new StageMcpError(
    `MCP server "${name}" failed to connect (status: ${status})`,
    "connect_failed",
  );
}

function timeoutError(pendingNames: readonly string[]): StageMcpError {
  if (pendingNames.length === 1) {
    return connectFailed(pendingNames[0]!, "timed out");
  }
  const listed = pendingNames.map((name) => `"${name}"`).join(", ");
  return new StageMcpError(
    `MCP servers ${listed} failed to connect (status: timed out)`,
    "connect_failed",
  );
}

function evaluateConnectStatus(
  serverNames: readonly string[],
  snapshot: IsolatedMcpStatusSnapshot | undefined,
): { kind: "ok" } | { kind: "wait"; pending: string[] } | { kind: "fail"; name: string; status: string } {
  if (snapshot === undefined) {
    return { kind: "wait", pending: [...serverNames] };
  }
  const byName = new Map(snapshot.servers.map((entry) => [entry.name, entry]));
  const pending: string[] = [];
  for (const name of serverNames) {
    const entry = byName.get(name);
    if (entry === undefined || entry.status === "not-connected") {
      pending.push(name);
      continue;
    }
    if (FAILURE_STATUSES.has(entry.status)) {
      return { kind: "fail", name, status: entry.status };
    }
    if (!SUCCESS_STATUSES.has(entry.status)) {
      pending.push(name);
    }
  }
  if (pending.length > 0) {
    return { kind: "wait", pending };
  }
  return { kind: "ok" };
}

function waitForIsolatedMcpConnect(
  snapshot: ResolvedMcpServers,
  source: IsolatedMcpStatusSource,
  options?: IsolatedMcpAttachOptions,
): { connecting: Promise<void>; cancel: () => void } {
  const serverNames = Object.keys(snapshot);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ISOLATED_MCP_CONNECT_TIMEOUT_MS;
  let lastSnapshot = source.read?.();
  let finish: (error?: StageMcpError) => void = () => {};

  const connecting = new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    finish = (error?: StageMcpError) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (poll !== undefined) clearInterval(poll);
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const consider = (next: IsolatedMcpStatusSnapshot | undefined) => {
      if (next !== undefined) lastSnapshot = next;
      const result = evaluateConnectStatus(serverNames, lastSnapshot);
      if (result.kind === "ok") {
        finish();
        return;
      }
      if (result.kind === "fail") {
        finish(connectFailed(result.name, result.status));
      }
    };

    consider(lastSnapshot);
    if (settled) return;

    unsubscribe = source.subscribe?.((next) => consider(next));
    consider(source.read?.());
    if (settled) return;

    if (source.read) {
      poll = setInterval(() => consider(source.read?.()), STATUS_POLL_MS);
    }

    timer = setTimeout(() => {
      const pending = evaluateConnectStatus(serverNames, lastSnapshot);
      finish(
        timeoutError(pending.kind === "wait" ? pending.pending : serverNames),
      );
    }, timeoutMs);
  });

  return {
    connecting,
    cancel() {
      void connecting.then(() => undefined, () => undefined);
      finish(new StageMcpError("MCP connect wait cancelled", "connect_failed"));
    },
  };
}

export function emitIsolatedMcpStatus(
  eventBus: EventBus,
  servers: ReadonlyArray<{ name: string; status: string }>,
): void {
  eventBus.emit(MCP_STATUS_EVENT, { servers });
}

export async function attachIsolatedMcp(
  snapshot?: ResolvedMcpServers,
  options?: IsolatedMcpAttachOptions,
): Promise<IsolatedMcpAttach> {
  if (snapshot === undefined || Object.keys(snapshot).length === 0) {
    return EMPTY_ATTACH;
  }
  const createMcpAdapter = await loadCreateMcpAdapter();
  const extensionFactories: InlineExtension[] = [
    {
      name: STAGEFLOW_PI_MCP_EXTENSION_NAME,
      factory: createMcpAdapter({
        config: toIsolatedMcpConfig(snapshot),
      }),
    },
  ];
  const eventBus = createEventBus();
  const { connecting, cancel } = waitForIsolatedMcpConnect(
    snapshot,
    mcpStatusSourceFromEvents(eventBus),
    options,
  );
  return { extensionFactories, eventBus, connecting, cancel };
}
