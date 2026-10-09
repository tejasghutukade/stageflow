import {
  type BrowserSandboxOrchestrator,
  SandboxError,
  type SandboxInfo,
  type SandboxLabels,
  type SandboxRef,
  type SandboxStartRequest,
  type SandboxStatus,
} from "./sandboxOrchestrator.js";

export type SessionApiState = "active" | "flushed" | "failed";

export type SessionApiSession = {
  id: string;
  state: SessionApiState;
  connect_url?: string;
  region: string;
  metadata: Record<string, string>;
};

export type SessionApiFailure = "unauthorized" | "quota_exceeded" | "unavailable" | "rejected";

export class SessionApiError extends Error {
  constructor(
    readonly failure: SessionApiFailure,
    message: string,
  ) {
    super(message);
    this.name = "SessionApiError";
  }
}

/**
 * The HTTP session API a managed browser provider exposes, reduced to the five calls an
 * orchestrator needs. A real provider adapter implements this against the vendor SDK; the
 * tests record the calls and answer from memory.
 */
export interface SessionApiClient {
  createSession(input: { metadata: Record<string, string>; persistContext?: string }): Promise<SessionApiSession>;
  getSession(id: string): Promise<SessionApiSession | undefined>;
  listSessions(): Promise<SessionApiSession[]>;
  flushSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export type SessionApiSandboxOrchestratorOptions = {
  client: SessionApiClient;
  adapterId?: string;
};

const ADAPTER_VERSION = 1;
const LABEL_PREFIX = "stageflow.";
const LABEL_KEYS: Array<[keyof SandboxLabels, string]> = [
  ["scope", "scope"],
  ["runId", "run"],
  ["stageId", "stage"],
  ["profile", "profile"],
];

function toMetadata(labels: SandboxLabels): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, name] of LABEL_KEYS) {
    const value = labels[key];
    if (value !== undefined) metadata[`${LABEL_PREFIX}${name}`] = value;
  }
  return metadata;
}

function fromMetadata(metadata: Record<string, string>): SandboxLabels {
  const labels: Record<string, string> = {};
  for (const [key, name] of LABEL_KEYS) {
    const value = metadata[`${LABEL_PREFIX}${name}`];
    if (value !== undefined) labels[key] = value;
  }
  return labels as SandboxLabels;
}

function statusOf(state: SessionApiState): SandboxStatus {
  if (state === "active") return "running";
  return state === "flushed" ? "stopped" : "dead";
}

function mapError(err: unknown): SandboxError {
  if (err instanceof SandboxError) return err;
  if (err instanceof SessionApiError) {
    const byFailure = {
      unauthorized: "not_authorized",
      quota_exceeded: "out_of_capacity",
      unavailable: "unavailable",
      rejected: "failed",
    } as const;
    return new SandboxError(byFailure[err.failure], err.message);
  }
  return new SandboxError("failed", err instanceof Error ? err.message : String(err));
}

export function createSessionApiSandboxOrchestrator(
  options: SessionApiSandboxOrchestratorOptions,
): BrowserSandboxOrchestrator {
  const { client } = options;
  const adapterId = options.adapterId ?? "session-api";

  function infoOf(session: SessionApiSession): SandboxInfo {
    const status = statusOf(session.state);
    return {
      ref: { id: session.id, adapter: { id: adapterId, version: ADAPTER_VERSION, data: { region: session.region } } },
      labels: fromMetadata(session.metadata),
      status,
      ...(status === "running" && session.connect_url !== undefined ? { attachAddress: session.connect_url } : {}),
    };
  }

  async function guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw mapError(err);
    }
  }

  return {
    async start(request: SandboxStartRequest): Promise<SandboxInfo> {
      if (request.egress !== undefined) {
        throw new SandboxError("not_supported", "this adapter cannot enforce an egress policy");
      }
      const session = await guard(() =>
        client.createSession({
          metadata: toMetadata(request.labels),
          ...(request.profile !== undefined ? { persistContext: `${request.profile.scope}/${request.profile.name}` } : {}),
        }),
      );
      return infoOf(session);
    },

    async stopGracefully(ref: SandboxRef): Promise<void> {
      await guard(async () => {
        if ((await client.getSession(ref.id)) !== undefined) await client.flushSession(ref.id);
      });
    },

    async listByLabel(labels: Partial<SandboxLabels>): Promise<SandboxInfo[]> {
      const wanted = toMetadata(labels as SandboxLabels);
      const sessions = await guard(() => client.listSessions());
      return sessions
        .filter((s) => Object.entries(wanted).every(([key, value]) => s.metadata[key] === value))
        .filter((s) => Object.keys(s.metadata).some((key) => key.startsWith(LABEL_PREFIX)))
        .map(infoOf);
    },

    async inspect(ref: SandboxRef): Promise<SandboxInfo | undefined> {
      const session = await guard(() => client.getSession(ref.id));
      return session === undefined ? undefined : infoOf(session);
    },

    async release(ref: SandboxRef): Promise<void> {
      await guard(() => client.deleteSession(ref.id));
    },
  };
}
