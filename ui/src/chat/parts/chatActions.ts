import { AgentApiError, agentsApi } from "../../api/agents";
import type { LiveQuery } from "../../redesign/artifacts/liveData/liveQuery";

export type ChatActionTarget = {
  agentId: string;
  sessionId: string;
};

export type ChatUiEventKind = "query" | "message" | "tool";

const inflight = new Map<string, { id: string; pending: Promise<Record<string, unknown>> }>();

function eventId(): string {
  return crypto.randomUUID();
}

export function resetChatActionsForTests(): void {
  inflight.clear();
}

/** One id per in-flight click. A second click waits on the first instead of starting another. */
export function postChatAction(
  target: ChatActionTarget,
  event: { key: string; version?: number; kind: ChatUiEventKind; action: string; args?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const mapKey = `${target.sessionId}\0${event.key}\0${event.version ?? ""}\0${event.kind}\0${event.action}\0${JSON.stringify(event.args ?? {})}`;
  const current = inflight.get(mapKey);
  if (current) return current.pending;
  const id = eventId();
  const pending = agentsApi
    .uiEvent(target.agentId, target.sessionId, {
      id,
      key: event.key,
      ...(event.version !== undefined ? { version: event.version } : {}),
      kind: event.kind,
      action: event.action,
      ...(event.args ? { args: event.args } : {}),
    })
    .finally(() => {
      if (inflight.get(mapKey)?.id === id) inflight.delete(mapKey);
    });
  inflight.set(mapKey, { id, pending });
  return pending;
}

/** Select and other viewer-arg changes re-query through the session, not the artifact page route. */
export function liveQueryFromChat(target: ChatActionTarget, key: string, version?: number): LiveQuery {
  return async ({ bindingId, args }) => {
    try {
      const body = await postChatAction(target, { key, ...(version !== undefined ? { version } : {}), kind: "query", action: bindingId, args });
      return { status: 200, body: body as never };
    } catch (error) {
      if (error instanceof AgentApiError) return { status: error.status, body: { code: error.code, error: error.message } };
      return { status: 0, body: null, networkError: error instanceof Error ? error.message : String(error) };
    }
  };
}
