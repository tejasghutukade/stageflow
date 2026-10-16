import type { ContactInfo } from "../../channels/types.js";
import { isAgentError } from "../errors.js";
import { SlidingWindowLimiter } from "../webChat/rateLimit.js";
import type { AgentChatController } from "../chatTurn.js";
import type { AgentService } from "../service.js";
import { parseAgentMailInbound, verifyAgentMailSignature } from "./agentmail.js";
import type { AgentInboundMessage } from "./port.js";
import { parseSlackInbound, verifySlackSignature } from "./slack.js";
import { parseTelegramInbound, verifyTelegramSecret } from "./telegram.js";

/** What the router needs from the Host's connections: who a connection is, and how to answer on it. */
export type InboundConnections = {
  find(connectionId: string): { provider: string; secret: string | undefined } | undefined;
  reply(connectionId: string, to: string, text: string, operationKey: string): Promise<void>;
  /** How people reach the connection (the number to text), when the provider can tell. */
  contact?(connectionId: string): Promise<ContactInfo | undefined>;
  /** The connection with its secrets, for providers the Host listens on itself (a stream instead of a webhook). */
  resolve?(connectionId: string): ListenerConnection | undefined;
};

export type ListenerConnection = {
  id: string;
  provider: string;
  config: unknown;
  secrets: Record<string, string>;
  credential?: { secrets: Record<string, string> } | undefined;
};

export type InboundResponse = { status: number; body?: unknown };

type Headers = Record<string, string | undefined>;

const MAX_REPLY_CHARS = 3500;
/** Messages one sender may send an agent per minute before the rest are ignored. */
const SENDER_LIMIT_PER_MINUTE = 20;

/**
 * Receives provider webhooks for agents. A request is accepted only when the connection has an
 * inbound secret and the provider's signature verifies; everything else is refused without
 * saying why. Replies go back on the same connection to the sender, once per turn.
 */
export class AgentInboundRouter {
  private readonly limiter = new SlidingWindowLimiter();

  constructor(
    private readonly options: {
      service: AgentService;
      chat: Pick<AgentChatController, "send">;
      connections: InboundConnections;
      projectRoot: string;
      logError?: (message: string) => void;
      senderLimitPerMinute?: number;
    },
  ) {}

  async handle(connectionId: string, headers: Headers, rawBody: string): Promise<InboundResponse> {
    const connection = this.options.connections.find(connectionId);
    if (!connection || connection.secret === undefined) return { status: 404 };
    const verified = this.verify(connection.provider, connection.secret, connectionId, headers, rawBody);
    if (!verified) return { status: 401 };

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400 };
    }
    if (connection.provider === "slack" && (payload as { type?: string })?.type === "url_verification") {
      return { status: 200, body: { challenge: (payload as { challenge?: string }).challenge } };
    }
    const parsed = this.parse(connection.provider, connectionId, connection.secret, headers, payload);
    if (!parsed) return { status: 400 };
    if ("ignored" in parsed) return { status: 200, body: { ignored: true } };
    return this.deliver(parsed.message);
  }

  /**
   * A message from any source (a webhook or a stream the Host listens on): enforce the sender allow-list and
   * rate limit, route it to its session and answer on the same connection.
   */
  async deliver(message: AgentInboundMessage): Promise<InboundResponse> {
    const limit = this.limiter.take(`${message.connectionId}\0${message.from ?? ""}`, this.options.senderLimitPerMinute ?? SENDER_LIMIT_PER_MINUTE, Date.now());
    if (!limit.ok) {
      this.options.logError?.(`agent inbound ${message.provider}: sender over the rate limit, message ignored`);
      return { status: 200, body: { ignored: true } };
    }
    let routed: Awaited<ReturnType<AgentService["receive"]>>;
    try {
      routed = await this.options.service.receive(this.options.projectRoot, message);
    } catch (error) {
      // An unbound, disabled or not-allowed sender looks the same as success to the sender; nothing is retried.
      if (isAgentError(error)) return { status: 200, body: { ignored: true } };
      throw error;
    }
    if (routed.duplicate) return { status: 200, body: { duplicate: true } };
    void this.converse(routed, message);
    return { status: 200, body: { ok: true } };
  }

  private verify(provider: string, secret: string, connectionId: string, headers: Headers, rawBody: string): boolean {
    if (provider === "slack") {
      return verifySlackSignature(
        { connectionId, signingSecret: secret },
        { ...(headers["x-slack-signature"] ? { signature: headers["x-slack-signature"] } : {}), ...(headers["x-slack-request-timestamp"] ? { requestTimestamp: headers["x-slack-request-timestamp"] } : {}) },
        rawBody,
      ).ok;
    }
    if (provider === "telegram") return verifyTelegramSecret({ connectionId, secretToken: secret }, headers["x-telegram-bot-api-secret-token"]).ok;
    if (provider === "agentmail") return verifyAgentMailSignature({ connectionId, webhookSecret: secret }, headers["x-agentmail-signature"], rawBody).ok;
    return false;
  }

  private parse(provider: string, connectionId: string, secret: string, _headers: Headers, payload: unknown): { message: AgentInboundMessage } | { ignored: true } | undefined {
    const result =
      provider === "slack"
        ? parseSlackInbound({ connectionId, signingSecret: secret }, payload)
        : provider === "telegram"
          ? parseTelegramInbound({ connectionId, secretToken: secret }, payload)
          : parseAgentMailInbound({ connectionId, webhookSecret: secret }, payload);
    if (!result.ok) return undefined;
    if ("ignored" in result) return { ignored: true };
    return { message: result.message };
  }

  /** After a restart: retry the turns it cut off on always-on iMessage agents, answering the same sender once. */
  async resumeInterrupted(): Promise<number> {
    const turns = await this.options.service.resumableTurns(this.options.projectRoot);
    for (const turn of turns) {
      const message: AgentInboundMessage = { provider: turn.provider as AgentInboundMessage["provider"], connectionId: turn.connectionId, eventId: `resume:${turn.turnId}`, threadId: turn.threadId, text: turn.text, from: turn.from, replyTo: turn.from };
      void this.converse({ agentId: turn.agentId, sessionId: turn.sessionId }, message, turn.turnId);
    }
    return turns.length;
  }

  private async converse(routed: { agentId: string; sessionId: string }, message: AgentInboundMessage, resumeTurnId?: string): Promise<void> {
    const { chat, connections, logError } = this.options;
    try {
      const detail = await chat.send({
        projectRoot: this.options.projectRoot,
        agentId: routed.agentId,
        sessionId: routed.sessionId,
        text: message.text,
        author: message.from ?? null,
        source: message.provider,
        ...(resumeTurnId ? { resumeTurnId } : {}),
      });
      const turn = detail.turns.at(-1);
      const reply = [...detail.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turn?.id);
      if (!turn || !reply || !message.replyTo) return;
      await this.options.service.sendOutbound(this.options.projectRoot, routed.sessionId, `reply:${turn.id}`, () =>
        connections.reply(message.connectionId, message.replyTo!, reply.text.slice(0, MAX_REPLY_CHARS), `agent-reply:${routed.sessionId}:${turn.id}`),
      );
    } catch (error) {
      if (isAgentError(error) && error.code === "agent.limit_reached" && message.replyTo) {
        await connections.reply(message.connectionId, message.replyTo, error.message, `agent-limit:${routed.sessionId}:${message.eventId}`).catch(() => undefined);
      }
      logError?.(`agent inbound ${message.provider} turn failed: ${isAgentError(error) ? error.code : error instanceof Error ? error.message : String(error)}`);
    }
  }
}
