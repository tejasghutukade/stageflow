import type { TriggerFile } from "../types/trigger.js";
import type { RunStore } from "../runstore/port.js";

export type TriggerAdapterStatus = {
  adapter: string;
  state: string;
  detail?: string;
  last_poll_at?: string;
  last_seen_at?: string;
  last_error?: string;
};

function parseGithubCursor(raw: string | null): { updatedAt?: string } | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: unknown };
    if (typeof parsed.updatedAt === "string") {
      return { updatedAt: parsed.updatedAt };
    }
    return {};
  } catch {
    return null;
  }
}

function mailboxKeyForTrigger(trigger: TriggerFile): string | undefined {
  const config = trigger.event?.config;
  const host = config?.host;
  const port = config?.port;
  const user = config?.user;
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    typeof user !== "string" ||
    user.length === 0
  ) {
    return undefined;
  }
  return `email:${host}:${port}:${user}`;
}

async function adapterStateUpdatedAt(
  store: RunStore,
  adapterId: string,
  key: string,
): Promise<string | undefined> {
  const meta = await store.getTriggerAdapterStateMeta(adapterId, key);
  return meta?.updated_at;
}

export async function readTriggerAdapterStatus(
  trigger: TriggerFile,
  store: RunStore,
): Promise<TriggerAdapterStatus> {
  if (!trigger.enabled) {
    return { adapter: trigger.kind, state: "disabled" };
  }

  if (trigger.kind === "manual") {
    return { adapter: "manual", state: "idle" };
  }

  if (trigger.kind === "schedule") {
    return { adapter: "schedule", state: "scheduled" };
  }

  const source = trigger.event?.source ?? "";
  if (source === "webhook") {
    return { adapter: "webhook", state: "ready", detail: "Endpoint ready when host is running" };
  }

  if (source.startsWith("github.")) {
    const repo = trigger.event?.config?.repo;
    if (typeof repo !== "string" || repo.length === 0) {
      return {
        adapter: "github",
        state: "error",
        detail: "event.config.repo is required",
      };
    }
    const adapterId = `github:${repo}`;
    const cursor = parseGithubCursor(await store.getTriggerAdapterState(adapterId, "cursor"));
    const lastPoll = await adapterStateUpdatedAt(store, adapterId, "etag");
    const lastSeen = cursor?.updatedAt ?? lastPoll;
    return {
      adapter: "github",
      state: cursor !== null || lastPoll !== undefined ? "polling" : "idle",
      ...(lastPoll !== undefined ? { last_poll_at: lastPoll } : {}),
      ...(lastSeen !== undefined ? { last_seen_at: lastSeen } : {}),
    };
  }

  if (source === "email.message") {
    const mailboxKey = mailboxKeyForTrigger(trigger);
    if (mailboxKey === undefined) {
      return {
        adapter: "email",
        state: "error",
        detail: "Incomplete email event.config",
      };
    }
    const uid = await store.getTriggerAdapterState(mailboxKey, "uid");
    const lastSeen = await adapterStateUpdatedAt(store, mailboxKey, "uid");
    return {
      adapter: "email",
      state: uid !== null ? "connected" : "watching",
      ...(lastSeen !== undefined ? { last_seen_at: lastSeen } : {}),
    };
  }

  return {
    adapter: source.length > 0 ? source : "event",
    state: "idle",
  };
}
