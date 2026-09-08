import { StageMcpError } from "../config/resolveStageMcpServers.js";
import type { ResolvedMcpServers } from "../config/resolveStageMcpServers.js";

export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const DEFAULT_ISOLATED_MCP_CONNECT_TIMEOUT_MS = 5_000;

const STATUS_POLL_MS = 50;

export type IsolatedMcpServerRuntimeStatus =
  | "connected"
  | "cached"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

export type IsolatedMcpStatusServer = {
  name: string;
  status: IsolatedMcpServerRuntimeStatus;
};

export type IsolatedMcpStatusSnapshot = {
  servers: ReadonlyArray<IsolatedMcpStatusServer>;
};

export type IsolatedMcpStatusSource = {
  read?: () => IsolatedMcpStatusSnapshot | undefined;
  subscribe?: (listener: (snapshot: IsolatedMcpStatusSnapshot) => void) => () => void;
};

export type IsolatedMcpConnectWaitOptions = {
  timeoutMs?: number;
};

export type IsolatedMcpStatusEvents = {
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
  off?(channel: string, handler: (data: unknown) => void): void;
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

export function asIsolatedMcpStatusSnapshot(
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

export function mcpStatusSourceFromEvents(
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

export async function waitForIsolatedMcpConnect(
  snapshot: ResolvedMcpServers | undefined,
  source: IsolatedMcpStatusSource = {},
  options?: IsolatedMcpConnectWaitOptions,
): Promise<void> {
  const serverNames = Object.keys(snapshot ?? {});
  if (serverNames.length === 0) {
    return;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_ISOLATED_MCP_CONNECT_TIMEOUT_MS;
  let lastSnapshot = source.read?.();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: StageMcpError) => {
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
}
