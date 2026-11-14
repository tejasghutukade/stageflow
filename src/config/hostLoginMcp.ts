import type { ResolvedMcpServers } from "./resolveStageMcpServers.js";

export type FrozenHostLoginServer = { readonly name: string; readonly url: string };

const EMPTY: readonly FrozenHostLoginServer[] = Object.freeze([]);

const byAttempt = new Map<string, readonly FrozenHostLoginServer[]>();

export function hostLoginAttemptKey(input: {
  runId?: string;
  stageId: string;
  attempt?: number;
}): string {
  return `${input.runId ?? ""}\u0000${input.stageId}\u0000${input.attempt ?? 1}`;
}

export function freezeHostLoginServers(
  attemptKey: string,
  servers: readonly { name: string; url: string }[],
): readonly FrozenHostLoginServer[] {
  const frozen = Object.freeze(
    servers.map((server) => Object.freeze({ name: server.name, url: server.url })),
  );
  byAttempt.set(attemptKey, frozen);
  return frozen;
}

export function readFrozenHostLoginServers(
  attemptKey: string,
): readonly FrozenHostLoginServer[] {
  return byAttempt.get(attemptKey) ?? EMPTY;
}

export function resetFrozenHostLoginServersForTests(): void {
  byAttempt.clear();
}

export function omitFrozenHostLogin(
  servers: ResolvedMcpServers | undefined,
  hostLogin: readonly { readonly name: string }[],
): ResolvedMcpServers {
  if (servers === undefined) return {};
  if (hostLogin.length === 0) return servers;
  const names = new Set(hostLogin.map((server) => server.name));
  const worker: ResolvedMcpServers = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!names.has(name)) worker[name] = entry;
  }
  return worker;
}
