import type { BrowserEndpointClient } from "../../src/browser/containerBrowserEndpoint.js";
import type { LiveViewAddress, LiveViewSource } from "../../src/browser/liveViewSource.js";
import {
  SessionApiError,
  type SessionApiClient,
  type SessionApiSession,
} from "../../src/browser/sessionApiSandboxOrchestrator.js";

export const FAKE_PROVIDER_VIEW_ORIGIN = "https://viewer.provider.test";

export type FakeProviderSession = {
  api: SessionApiClient;
  endpoint: BrowserEndpointClient;
  /** Every call the adapter made, as `<verb>:<arg>`; credentials are never part of a call. */
  calls: string[];
  /** Ordered record of browser closes (`close:<n>`). */
  events: string[];
  sessions: Map<string, SessionApiSession>;
  /** The next createSession fails this way. */
  failNext(failure: "unauthorized" | "quota_exceeded" | "unavailable" | "rejected"): void;
  crash(id: string): void;
  addressOf(n: number): string;
  viewerSource(options?: { ttlMs?: number; now?: () => number }): LiveViewSource & { issued: LiveViewAddress[] };
};

/** A recorded-API stand-in for a managed provider: its own session shape, auth check and viewer. */
export function createFakeProviderSession(options: { apiKey?: string; presentedKey?: string } = {}): FakeProviderSession {
  const sessions = new Map<string, SessionApiSession>();
  const browserUp = new Set<string>();
  const calls: string[] = [];
  const events: string[] = [];
  let counter = 0;
  let failure: "unauthorized" | "quota_exceeded" | "unavailable" | "rejected" | undefined;
  const addressOf = (n: number) => `ws://10.1.0.${n}:9222/devtools/browser/p${n}`;
  const nOf = (id: string) => Number(id.replace("psess_", ""));
  const idOfHost = (endpoint: string) => {
    const n = Number(new URL(endpoint.replace(/^ws/, "http")).hostname.split(".")[3]);
    return `psess_${n}`;
  };

  function authorize(): void {
    if (options.apiKey !== undefined && options.presentedKey !== options.apiKey) {
      throw new SessionApiError("unauthorized", "invalid credentials");
    }
  }

  const api: SessionApiClient = {
    async createSession(input) {
      authorize();
      calls.push(`create:${input.persistContext ?? ""}`);
      if (failure !== undefined) {
        const f = failure;
        failure = undefined;
        throw new SessionApiError(f, `provider refused: ${f}`);
      }
      counter += 1;
      const session: SessionApiSession = {
        id: `psess_${counter}`,
        state: "active",
        connect_url: addressOf(counter),
        region: "test-1",
        metadata: { ...input.metadata },
      };
      sessions.set(session.id, session);
      browserUp.add(session.id);
      return structuredClone(session);
    },
    async getSession(id) {
      authorize();
      calls.push(`get:${id}`);
      const found = sessions.get(id);
      return found === undefined ? undefined : structuredClone(found);
    },
    async listSessions() {
      authorize();
      calls.push("list");
      return [...sessions.values()].map((s) => structuredClone(s));
    },
    async flushSession(id) {
      authorize();
      calls.push(`flush:${id}`);
      const found = sessions.get(id);
      if (found === undefined) return;
      found.state = "flushed";
      delete found.connect_url;
      browserUp.delete(id);
    },
    async deleteSession(id) {
      authorize();
      calls.push(`delete:${id}`);
      sessions.delete(id);
      browserUp.delete(id);
    },
  };

  const endpoint: BrowserEndpointClient = {
    async resolve(address) {
      const id = idOfHost(address);
      const session = sessions.get(id);
      if (session === undefined || session.state !== "active" || !browserUp.has(id)) return undefined;
      return session.connect_url;
    },
    async closeBrowser(address) {
      const id = idOfHost(address);
      events.push(`close:${nOf(id)}`);
      browserUp.delete(id);
    },
  };

  return {
    api,
    endpoint,
    calls,
    events,
    sessions,
    failNext: (f) => {
      failure = f;
    },
    crash: (id) => void browserUp.delete(id),
    addressOf,
    viewerSource(viewerOptions = {}) {
      const ttlMs = viewerOptions.ttlMs ?? 60_000;
      const now = viewerOptions.now ?? Date.now;
      const issued: LiveViewAddress[] = [];
      return {
        issued,
        async viewerAddress(request) {
          if (!sessions.has(request.sandboxId)) throw new Error("no such session");
          const address: LiveViewAddress = {
            url: `${FAKE_PROVIDER_VIEW_ORIGIN}/live/${request.sandboxId}?access_token=tok-${issued.length + 1}-${Math.random().toString(36).slice(2, 10)}`,
            embedOrigin: FAKE_PROVIDER_VIEW_ORIGIN,
            expiresAt: now() + ttlMs,
          };
          issued.push(address);
          return address;
        },
      };
    },
  };
}
