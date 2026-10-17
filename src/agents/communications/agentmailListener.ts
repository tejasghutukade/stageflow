import type { AgentInboundMessage } from "./port.js";
import { abortableSleep, reconnectDelay, StateTracker, type ChannelListener, type ListenerDeps } from "./listener.js";

/** The slice of the AgentMail SDK socket this listener uses; tests supply a fake. */
export type AgentMailSocket = {
  on(event: "open" | "message" | "close" | "error", callback: (payload?: any) => void): void;
  sendSubscribe(message: { type: "subscribe"; inboxIds: string[]; eventTypes: string[] }): void;
  waitForOpen(): Promise<unknown>;
  close(): void;
};

export type AgentMailMessage = {
  inboxId: string;
  threadId: string;
  messageId: string;
  labels?: string[];
  timestamp?: string | Date;
  from: string;
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  headers?: Record<string, string>;
};

export type AgentMailTransport = {
  connect(): Promise<AgentMailSocket>;
  /** Mail that arrived while the Host was not listening. */
  recent(inbox: string, since: Date): Promise<AgentMailMessage[]>;
};

export type AgentMailListenerConfig = { connectionId: string; inbox: string };

const NOREPLY_LOCALPART = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[sd]?|notifications?)([+._-].*)?$/i;

/** The bare address of "Name <a@b.com>", lowercased. */
export function addressOf(from: string): string {
  const angle = /<([^<>]+)>/.exec(from);
  return (angle ? angle[1]! : from).trim().toLowerCase();
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Why an email must not get an answer, or undefined when it should. Keeps the agent out of mail loops:
 * its own mail, bounces, automatic replies and no-reply senders.
 */
export function ignoreReason(message: AgentMailMessage, inbox: string): string | undefined {
  const labels = message.labels ?? [];
  if (labels.includes("sent") || (labels.length > 0 && !labels.includes("received"))) return "not received mail";
  const sender = addressOf(message.from);
  if (sender === inbox.toLowerCase()) return "from the agent's own inbox";
  const local = sender.split("@")[0] ?? "";
  if (NOREPLY_LOCALPART.test(local)) return "from a no-reply or system sender";
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]));
  if (headers["auto-submitted"] !== undefined && headers["auto-submitted"] !== "no") return "automatic reply";
  if (headers["x-auto-response-suppress"] !== undefined) return "automatic reply";
  if (["bulk", "list", "junk"].includes(headers.precedence ?? "")) return "bulk mail";
  return undefined;
}

/** What the agent reads: the new text of the email (no quoted history), led by the subject on a first message. */
export function bodyOf(message: AgentMailMessage): string {
  const body = (message.extractedText ?? message.text ?? (message.html ? stripHtml(message.html) : "")).trim();
  const subject = message.subject?.trim();
  if (body.length === 0) return "";
  return subject && !/^(re|fwd?):/i.test(subject) ? `Subject: ${subject}\n\n${body}` : body;
}

export function toInbound(connectionId: string, message: AgentMailMessage): AgentInboundMessage | undefined {
  const text = bodyOf(message);
  if (text.length === 0) return undefined;
  return {
    provider: "agentmail",
    connectionId,
    // The message id (not the event id) so the live stream and the catch-up list dedupe against each other.
    eventId: `agentmail:${message.messageId}`,
    threadId: message.threadId,
    text,
    from: message.from,
    replyTo: message.messageId,
  };
}

/** Minutes of missed mail answered after a reconnect or restart. */
export const CATCHUP_MINUTES = 15;

/**
 * Holds an AgentMail WebSocket open for one inbox. A dropped connection is retried with backoff and, once back,
 * mail that arrived meanwhile is answered too (deduped by message id). Only `message.received` events count:
 * spam, blocked and unauthenticated (spoofed sender) mail uses other event types and never reaches an agent.
 */
export function createAgentMailListener(config: AgentMailListenerConfig, transport: AgentMailTransport, deps: ListenerDeps): ChannelListener {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const tracker = new StateTracker(now);
  const abort = new AbortController();
  let loop: Promise<void> | undefined;
  let socket: AgentMailSocket | undefined;

  async function handle(message: AgentMailMessage): Promise<void> {
    const reason = ignoreReason(message, config.inbox);
    if (reason) {
      deps.log(`agentmail ${config.connectionId}: ignored a message (${reason})`);
      return;
    }
    const inbound = toInbound(config.connectionId, message);
    if (!inbound) return;
    tracker.received();
    await deps.onMessage(inbound).catch((error) => deps.log(`agentmail ${config.connectionId}: delivery failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function session(): Promise<void> {
    const opened = await transport.connect();
    socket = opened;
    const closed = new Promise<string | undefined>((resolve) => {
      opened.on("close", () => resolve(undefined));
      opened.on("error", (error) => resolve(error instanceof Error ? error.message : "connection error"));
    });
    opened.on("message", (payload: { type?: string; eventType?: string; message?: AgentMailMessage }) => {
      if (payload?.type === "event" && payload.eventType === "message.received" && payload.message && payload.message.inboxId === config.inbox) void handle(payload.message);
    });
    await opened.waitForOpen();
    opened.sendSubscribe({ type: "subscribe", inboxIds: [config.inbox], eventTypes: ["message.received"] });
    tracker.set("connected");
    const missed = await transport.recent(config.inbox, new Date(now() - CATCHUP_MINUTES * 60_000)).catch(() => [] as AgentMailMessage[]);
    for (const message of missed) await handle(message);
    const reason = await Promise.race([closed, new Promise<string | undefined>((resolve) => abort.signal.addEventListener("abort", () => resolve(undefined), { once: true }))]);
    if (!abort.signal.aborted) throw new Error(reason ?? "connection closed");
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!abort.signal.aborted) {
      try {
        await session();
        attempt = 0;
      } catch (error) {
        if (abort.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        tracker.set(attempt === 0 ? "reconnecting" : "failed", message);
        deps.log(`agentmail ${config.connectionId}: ${message}; retrying`);
        attempt += 1;
        await sleep(reconnectDelay(attempt - 1), abort.signal);
      } finally {
        try {
          socket?.close();
        } catch {
          // already closed
        }
        socket = undefined;
      }
    }
    tracker.set("stopped");
  }

  return {
    async start() {
      loop = run();
      await Promise.resolve();
    },
    async stop() {
      abort.abort();
      try {
        socket?.close();
      } catch {
        // already closed
      }
      await loop;
    },
    state: () => tracker.get(),
  };
}

/** The real transport over the AgentMail SDK. The SDK loads on first use, so a Host without AgentMail never needs it. */
export function sdkAgentMailTransport(options: { apiKey: string; region: "us" | "eu"; inbox: string }): AgentMailTransport {
  let client: any;
  const load = async () => {
    if (client) return client;
    const sdk: any = await import("agentmail");
    client = new sdk.AgentMailClient({ apiKey: options.apiKey, environment: options.region === "eu" ? sdk.AgentMailEnvironment.EuProd : sdk.AgentMailEnvironment.Prod });
    return client;
  };
  return {
    async connect() {
      const sdkClient = await load();
      const socket = await sdkClient.websockets.connect({ reconnectAttempts: 0 });
      return socket as AgentMailSocket;
    },
    async recent(inbox, since) {
      const sdkClient = await load();
      const page = await sdkClient.inboxes.messages.list(inbox, { after: since, labels: ["received"], limit: 50, ascending: true });
      // The list carries previews only; the agent needs the body.
      const full = await Promise.all((page.messages ?? []).map((item: { messageId: string }) => sdkClient.inboxes.messages.get(inbox, item.messageId)));
      return full as AgentMailMessage[];
    },
  };
}
