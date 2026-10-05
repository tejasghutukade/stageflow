import { randomBytes } from "node:crypto";

export type LiveViewMode = "view" | "control";

export type LiveViewTarget = {
  scope: string;
  runId: string;
  stageId: string;
};

export type LiveViewGrant = LiveViewTarget & { mode: LiveViewMode };

export type LiveViewTicketRequest = LiveViewGrant & { callerId?: string | null };

export type LiveViewCredential = LiveViewGrant & {
  credential: string;
  callerId: string | null;
};

export interface LiveViewTicketService {
  /** One-use, short-lived; bound to scope, run, stage and mode. */
  issue(request: LiveViewTicketRequest): { ticket: string; expiresAt: number };
  /** Spends the ticket whatever the outcome; refused when unknown, expired, reused or for another target. */
  redeem(ticket: string, target: LiveViewTarget): LiveViewCredential | undefined;
  /** Looks up a live-view credential for the same target; undefined when unknown, expired or revoked. */
  resolve(credential: string, target: LiveViewTarget): LiveViewCredential | undefined;
  /** Invalidates tickets and credentials of one stage. */
  revoke(runId: string, stageId: string): void;
  /** Invalidates tickets and credentials of every stage of a run. */
  revokeRun(runId: string): void;
  /** Invalidates every ticket and credential. */
  revokeAll(): void;
  /** Listeners receive the credentials that were just invalidated. */
  onRevoked(listener: (credentials: readonly string[]) => void): () => void;
}

export const LIVE_VIEW_TICKET_TTL_MS = 60_000;
export const LIVE_VIEW_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;

export type LiveViewTicketServiceOptions = {
  now?: () => number;
  randomToken?: () => string;
  ticketTtlMs?: number;
  credentialTtlMs?: number;
};

type TicketEntry = LiveViewGrant & { callerId: string | null; expiresAt: number };

function sameTarget(a: LiveViewTarget, b: LiveViewTarget): boolean {
  return a.scope === b.scope && a.runId === b.runId && a.stageId === b.stageId;
}

export function createLiveViewTicketService(
  options: LiveViewTicketServiceOptions = {},
): LiveViewTicketService {
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const ticketTtlMs = options.ticketTtlMs ?? LIVE_VIEW_TICKET_TTL_MS;
  const credentialTtlMs = options.credentialTtlMs ?? LIVE_VIEW_CREDENTIAL_TTL_MS;
  const tickets = new Map<string, TicketEntry>();
  const credentials = new Map<string, TicketEntry>();
  const listeners = new Set<(credentials: readonly string[]) => void>();

  function sweep(): void {
    const at = now();
    for (const [key, entry] of tickets) if (entry.expiresAt <= at) tickets.delete(key);
    for (const [key, entry] of credentials) if (entry.expiresAt <= at) credentials.delete(key);
  }

  function revokeWhere(matches: (entry: TicketEntry) => boolean): void {
    for (const [key, entry] of tickets) if (matches(entry)) tickets.delete(key);
    const revoked: string[] = [];
    for (const [key, entry] of credentials) {
      if (!matches(entry)) continue;
      credentials.delete(key);
      revoked.push(key);
    }
    if (revoked.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(revoked);
      } catch {
        // a failing listener must not block revocation
      }
    }
  }

  return {
    issue(request) {
      sweep();
      const ticket = randomToken();
      const expiresAt = now() + ticketTtlMs;
      tickets.set(ticket, {
        scope: request.scope,
        runId: request.runId,
        stageId: request.stageId,
        mode: request.mode,
        callerId: request.callerId ?? null,
        expiresAt,
      });
      return { ticket, expiresAt };
    },
    redeem(ticket, target) {
      const entry = tickets.get(ticket);
      if (entry === undefined) return undefined;
      tickets.delete(ticket);
      if (entry.expiresAt <= now() || !sameTarget(entry, target)) return undefined;
      const credential = randomToken();
      credentials.set(credential, { ...entry, expiresAt: now() + credentialTtlMs });
      return {
        credential,
        scope: entry.scope,
        runId: entry.runId,
        stageId: entry.stageId,
        mode: entry.mode,
        callerId: entry.callerId,
      };
    },
    resolve(credential, target) {
      const entry = credentials.get(credential);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        credentials.delete(credential);
        return undefined;
      }
      if (!sameTarget(entry, target)) return undefined;
      return {
        credential,
        scope: entry.scope,
        runId: entry.runId,
        stageId: entry.stageId,
        mode: entry.mode,
        callerId: entry.callerId,
      };
    },
    revoke(runId, stageId) {
      revokeWhere((entry) => entry.runId === runId && entry.stageId === stageId);
    },
    revokeRun(runId) {
      revokeWhere((entry) => entry.runId === runId);
    },
    revokeAll() {
      revokeWhere(() => true);
    },
    onRevoked(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
