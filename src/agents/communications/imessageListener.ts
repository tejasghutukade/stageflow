import { normalizeSender } from "./allowlist.js";
import { abortableSleep, reconnectDelay, StateTracker, type ChannelListener, type ListenerDeps } from "./listener.js";
import type { AgentInboundMessage } from "./port.js";

/** What this listener reads of a Spectrum message. */
export type SpectrumInbound = {
  id: string;
  direction?: string;
  content?: { type?: string; text?: string };
  sender?: { id?: string } | undefined;
  space?: { id?: string; type?: string } | undefined;
};

export type SpectrumStream = {
  messages: AsyncIterable<[unknown, SpectrumInbound]>;
  stop(): Promise<void>;
};

export type IMessageTransport = { open(): Promise<SpectrumStream> };

export type IMessageListenerConfig = { connectionId: string };

/** The text and sender of a message the agent should answer, or undefined for everything else. */
export function toInbound(connectionId: string, message: SpectrumInbound): AgentInboundMessage | undefined {
  if (message.direction !== undefined && message.direction !== "inbound") return undefined;
  if (message.content?.type !== "text") return undefined;
  const text = message.content.text?.trim() ?? "";
  const sender = message.sender?.id;
  if (text.length === 0 || !sender) return undefined;
  // Group chats are out of scope: replying to one person's handle would answer the wrong audience.
  if (message.space?.type === "group") return undefined;
  const from = normalizeSender(sender);
  return { provider: "imessage", connectionId, eventId: `imessage:${message.id}`, threadId: from, text, from, replyTo: from };
}

/**
 * Holds a Spectrum (Photon) stream open for an iMessage line. One conversation per sender, so with an
 * always-on agent each person has one session that carries on after a failure. A dropped stream is
 * reopened with backoff.
 */
export function createIMessageListener(config: IMessageListenerConfig, transport: IMessageTransport, deps: ListenerDeps): ChannelListener {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const tracker = new StateTracker(now);
  const abort = new AbortController();
  let loop: Promise<void> | undefined;
  let stream: SpectrumStream | undefined;

  async function session(): Promise<void> {
    stream = await transport.open();
    tracker.set("connected");
    for await (const [, message] of stream.messages) {
      if (abort.signal.aborted) return;
      const inbound = toInbound(config.connectionId, message);
      if (!inbound) continue;
      tracker.received();
      await deps.onMessage(inbound).catch((error) => deps.log(`imessage ${config.connectionId}: delivery failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (!abort.signal.aborted) throw new Error("stream ended");
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
        deps.log(`imessage ${config.connectionId}: ${message}; retrying`);
        attempt += 1;
        await sleep(reconnectDelay(attempt - 1), abort.signal);
      } finally {
        await stream?.stop().catch(() => undefined);
        stream = undefined;
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
      await stream?.stop().catch(() => undefined);
      await loop;
    },
    state: () => tracker.get(),
  };
}

/** The real transport over the Spectrum SDK; the packages load on first use. */
export function sdkIMessageTransport(credentials: { projectId: string; projectSecret: string }, importer: (specifier: string) => Promise<any> = (s) => import(s)): IMessageTransport {
  return {
    async open() {
      const core = await importer("@spectrum-ts/core");
      const module = await importer("@spectrum-ts/imessage");
      const app = await core.Spectrum({ projectId: credentials.projectId, projectSecret: credentials.projectSecret, providers: [module.imessage.config()] });
      return { messages: app.messages as AsyncIterable<[unknown, SpectrumInbound]>, stop: () => app.stop() };
    },
  };
}
