import { randomUUID } from "node:crypto";
import { logger as rootLogger } from "../logging/logger.js";
import {
  STAGEFLOW_GUIDE_GREETING,
  STAGEFLOW_GUIDE_PROFILE_ID,
  createStageflowGuideProfile,
  type OperatorAgentHost,
  type OperatorAgentSession,
  type WorkshopToolActivityUpdate,
} from "../operatorAgent/index.js";
import { redactString } from "../logging/redact.js";
import { buildWorkshopChatPrompt, parseWorkshopChatAttachments } from "../workshop/chatAttachments.js";
import { resolveWorkshopModel } from "../workshop/modelSettings.js";
import { advanceGuideTurn } from "../operatorAgent/profiles/guideConfirm.js";
import { GUIDE_UI_TOOL_NAMES } from "./showUi.js";
import {
  guideTitleFrom,
  readGuideThread,
  saveGuideThread,
  type GuideMessage,
  type GuidePart,
  type GuideThreadRecord,
} from "./threadStore.js";

const log = rootLogger.child({ component: "guide" });

export const GUIDE_MAX_MESSAGE_CHARS = 8000;

export class GuideError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "GuideError";
  }
}

export const GUIDE_TOOL_RESULT_MAX_BYTES = 20_000;
const GUIDE_TOOL_ERROR_MAX_CHARS = 300;
const GUIDE_KEPT_RESULT_TOOLS: ReadonlySet<string> = new Set(GUIDE_UI_TOOL_NAMES);
const SECRET_KEY = /secret|password|passwd|token|api_?key/i;

export type GuideToolFrame = {
  type: "tool";
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type GuideFrame =
  | { type: "delta"; text: string }
  | GuideToolFrame
  | { type: "done"; message: GuideMessage }
  | { type: "error"; code: string; message: string };

const sessions = new Map<string, OperatorAgentSession>();
const running = new Set<string>();

export function resetGuideSessionsForTests(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
  running.clear();
}

export function guideAgentInfo(host: OperatorAgentHost): { name: string; greeting: string } {
  const profile = host.getProfile(STAGEFLOW_GUIDE_PROFILE_ID);
  return {
    name: profile?.title ?? createStageflowGuideProfile().title,
    greeting: profile?.greeting ?? STAGEFLOW_GUIDE_GREETING,
  };
}

export function isGuideThreadRunning(threadId: string): boolean {
  return running.has(threadId);
}

async function openGuideSession(
  host: OperatorAgentHost,
  record: GuideThreadRecord,
): Promise<OperatorAgentSession> {
  const existing = sessions.get(record.id);
  if (existing) return existing;
  const profile = host.getProfile(STAGEFLOW_GUIDE_PROFILE_ID);
  if (!profile) throw new GuideError("guide.unavailable", 503);
  const session = host.openSession({
    profileId: STAGEFLOW_GUIDE_PROFILE_ID,
    context: { kind: "stageflow_guide" },
  });
  sessions.set(record.id, session);
  if (record.messages.length > 0) {
    await session.prepareRestart?.(record.messages.map((message) => ({ role: message.role, text: message.text })));
  }
  return session;
}

function assistantText(events: readonly { type: string; role?: string; text?: string }[]): string {
  return events
    .filter((event) => event.type === "message" && event.role === "assistant" && typeof event.text === "string")
    .map((event) => event.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

export async function* streamGuideTurn(input: {
  host: OperatorAgentHost;
  threadId: string;
  text: string;
  attachments?: unknown;
  model?: string | null;
  storeRoot?: string;
  signal?: AbortSignal;
}): AsyncGenerator<GuideFrame> {
  const text = input.text.trim();
  const parsedAttachments = parseWorkshopChatAttachments(input.attachments);
  if (!parsedAttachments.ok) throw new GuideError("guide.attachment", 400);
  const attachments = parsedAttachments.attachments;
  if (!text && attachments.length === 0) throw new GuideError("guide.invalid", 400);
  if (text.length > GUIDE_MAX_MESSAGE_CHARS) throw new GuideError("guide.message_too_long", 413);
  const record = readGuideThread(input.threadId, input.storeRoot);
  if (!record) throw new GuideError("guide.not_found", 404);
  if (running.has(record.id)) throw new GuideError("guide.busy", 409);
  if (input.signal?.aborted) return;

  running.add(record.id);
  let live: ReturnType<typeof createFrameQueue> | undefined;
  try {
    const now = new Date().toISOString();
    const attachmentMeta = attachments.map(({ name, size, mediaType }) => ({ name, size, mediaType }));
    const userMessage: GuideMessage = {
      id: randomUUID(),
      role: "user",
      text,
      createdAt: now,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    };
    const titled = record.title.trim() ? record : { ...record, title: guideTitleFrom(text || attachments[0]?.name || "") };
    const incoming =
      typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
    const sessionModel = incoming ?? record.model;
    saveGuideThread(
      {
        ...titled,
        updatedAt: now,
        messages: [...titled.messages, userMessage],
        ...(sessionModel ? { model: sessionModel } : {}),
      },
      input.storeRoot,
    );

    const queue = createFrameQueue();
    live = queue;
    let streamed = "";
    const parts = createPartsRecorder();
    const session = await openGuideSession(input.host, titled);
    const onAbort = () => {
      void session.abort();
    };
    input.signal?.addEventListener("abort", onAbort);
    const prompt = buildWorkshopChatPrompt(text || "Please look at the attached files.", attachments, null);
    const modelId = resolveWorkshopModel({ sessionOverride: sessionModel });
    session.setContext(advanceGuideTurn(session.getContext()));
    const finished = session
      .send(prompt, {
        modelId,
        onDelta: (delta) => {
          streamed += delta;
          parts.text(delta);
          queue.push({ type: "delta", text: delta });
        },
        onActivity: (update) => {
          queue.push(parts.tool(update));
        },
      })
      .then((events) => ({ ok: true as const, events }))
      .catch((err: unknown) => ({ ok: false as const, err }))
      .finally(() => queue.close());

    for await (const frame of queue.frames()) {
      yield frame;
      if (input.signal?.aborted) break;
    }

    const result = await finished;
    input.signal?.removeEventListener("abort", onAbort);
    if (input.signal?.aborted) {
      persistAssistant(input.threadId, input.storeRoot, streamed, parts.finish());
      return;
    }
    if (!result.ok) {
      if (result.err instanceof GuideError) throw result.err;
      persistAssistant(input.threadId, input.storeRoot, streamed, parts.finish());
      log.warn("guide.turn.failed", "turn failed", { threadId: record.id });
      yield { type: "error", code: "guide.failed", message: "" };
      return;
    }
    const reply = assistantText(result.events) || streamed;
    const failed = result.events.some((event) => event.type === "error");
    if (failed && !reply) {
      log.warn("guide.turn.failed", "turn failed", { threadId: record.id });
      yield { type: "error", code: "guide.failed", message: "" };
      return;
    }
    if (reply.startsWith(streamed)) {
      const rest = reply.slice(streamed.length);
      if (rest) {
        parts.text(rest);
        yield { type: "delta", text: rest };
      }
    } else if (reply && reply !== streamed) {
      parts.replaceText(reply);
      yield { type: "delta", text: reply };
    }
    const saved = persistAssistant(input.threadId, input.storeRoot, reply, parts.finish());
    if (saved) yield { type: "done", message: saved };
    else yield { type: "error", code: "guide.failed", message: "" };
  } catch (err) {
    if (input.signal?.aborted) return;
    if (err instanceof GuideError) throw err;
    log.warn("guide.turn.failed", "turn failed", { threadId: record.id });
    yield { type: "error", code: "guide.failed", message: "" };
  } finally {
    live?.close();
    running.delete(record.id);
  }
}

function createFrameQueue(): {
  push(frame: GuideFrame): void;
  close(): void;
  frames(): AsyncGenerator<GuideFrame>;
} {
  const items: GuideFrame[] = [];
  let pending: ((frame: GuideFrame | null) => void) | null = null;
  let closed = false;
  return {
    push(frame) {
      if (closed) return;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(frame);
      } else {
        items.push(frame);
      }
    },
    close() {
      closed = true;
      pending?.(null);
      pending = null;
    },
    async *frames() {
      while (true) {
        const next = await new Promise<GuideFrame | null>((resolve) => {
          if (items.length > 0) {
            resolve(items.shift() ?? null);
            return;
          }
          if (closed) {
            resolve(null);
            return;
          }
          pending = resolve;
        });
        if (!next) return;
        yield next;
      }
    },
  };
}

function scrubSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = key === "secrets" || (SECRET_KEY.test(key) && typeof child === "string")
        ? "[redacted]"
        : scrubSecrets(child);
    }
    return out;
  }
  return value;
}

function boundedResult(name: string, result: unknown): unknown {
  const scrubbed = scrubSecrets(result);
  if (GUIDE_KEPT_RESULT_TOOLS.has(name)) return scrubbed;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(scrubbed) ?? "");
  } catch {
    return { truncated: true };
  }
  return bytes > GUIDE_TOOL_RESULT_MAX_BYTES ? { truncated: true } : scrubbed;
}

function boundedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubSecrets(args) as Record<string, unknown>;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(scrubbed));
  } catch {
    return { truncated: true };
  }
  return bytes > GUIDE_TOOL_RESULT_MAX_BYTES ? { truncated: true } : scrubbed;
}

function shortError(message: string | undefined): string {
  const text = redactString((message ?? "").trim()) || "tool_failed";
  return text.length > GUIDE_TOOL_ERROR_MAX_CHARS ? `${text.slice(0, GUIDE_TOOL_ERROR_MAX_CHARS - 1)}…` : text;
}

type RunningToolPart = {
  type: "tool";
  id: string;
  name: string;
  status: "running";
  args?: Record<string, unknown>;
};

function createPartsRecorder(): {
  text(delta: string): void;
  replaceText(text: string): void;
  tool(update: WorkshopToolActivityUpdate): GuideToolFrame;
  finish(): GuidePart[];
} {
  let parts: Array<GuidePart | RunningToolPart> = [];
  let pending = "";
  const flush = () => {
    if (!pending) return;
    parts.push({ type: "text", text: pending });
    pending = "";
  };
  return {
    text(delta) {
      pending += delta;
    },
    replaceText(text) {
      parts = parts.filter((part) => part.type !== "text");
      pending = text;
    },
    tool(update) {
      const base = { type: "tool" as const, id: update.id, name: update.name };
      let frame: GuideToolFrame;
      if (update.status === "running") {
        frame = { ...base, status: "running", ...(update.args ? { args: boundedArgs(update.args) } : {}) };
      } else if (update.status === "complete") {
        frame = { ...base, status: "complete", ...(update.result !== undefined ? { result: boundedResult(update.name, update.result) } : {}) };
      } else {
        frame = { ...base, status: "error", error: shortError(update.errorMessage) };
      }
      const index = parts.findIndex((part) => part.type === "tool" && part.id === update.id && part.status === "running");
      if (frame.status === "running") {
        if (index !== -1) return frame;
        flush();
        parts.push({ ...base, status: "running", ...(frame.args ? { args: frame.args } : {}) });
        return frame;
      }
      const started = index === -1 ? undefined : (parts[index] as RunningToolPart);
      const done: GuidePart = {
        ...base,
        status: frame.status,
        ...(started?.args ? { args: started.args } : {}),
        ...(frame.result !== undefined ? { result: frame.result } : {}),
        ...(frame.error !== undefined ? { error: frame.error } : {}),
      };
      if (index === -1) {
        flush();
        parts.push(done);
      } else {
        parts[index] = done;
      }
      return frame;
    },
    finish() {
      flush();
      return parts.map((part) =>
        part.type === "tool" && part.status === "running"
          ? { ...part, status: "error" as const, error: "guide.tool_interrupted" }
          : (part as GuidePart),
      );
    },
  };
}

function persistAssistant(
  threadId: string,
  storeRoot: string | undefined,
  text: string,
  parts: GuidePart[] = [],
): GuideMessage | null {
  const reply = text.trim();
  if (!reply && !parts.some((part) => part.type === "tool")) return null;
  const latest = readGuideThread(threadId, storeRoot);
  if (!latest) return null;
  const message: GuideMessage = {
    id: randomUUID(),
    role: "assistant",
    text: reply,
    createdAt: new Date().toISOString(),
    ...(parts.length > 0 ? { parts } : {}),
  };
  saveGuideThread({
    ...latest,
    updatedAt: message.createdAt,
    messages: [...latest.messages, message],
  }, storeRoot);
  return message;
}
