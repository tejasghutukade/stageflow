import { assistantMessageTextForChannel } from "../../channels/renderUiPart.js";
import type { ContactInfo } from "../../channels/types.js";
import type { ConsumerAuthorization } from "../../identity/authorization.js";
import { isAgentError } from "../errors.js";
import { ReplyDelivery } from "./delivery.js";
import { SlidingWindowLimiter } from "../../util/slidingWindowLimiter.js";
import type { AgentChatController } from "../chatTurn.js";
import type { AgentService } from "../service.js";
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

/** Providers that reach an agent by webhook. AgentMail and iMessage are listened to instead (a stream the Host opens). */
const WEBHOOK_PROVIDERS = new Set(["slack", "telegram"]);

/**
 * Receives provider webhooks for agents. A request is accepted only when the connection has an
 * inbound secret and the provider's signature verifies; everything else is refused without
 * saying why. Replies go back on the same connection to the sender, once per turn.
 */
export class AgentInboundRouter {
  private readonly limiter = new SlidingWindowLimiter();
  /** Sends each reply back and keeps track of whether it got through. */
  readonly delivery: ReplyDelivery;

  constructor(
    private readonly options: {
      service: AgentService;
      chat: Pick<AgentChatController, "send">;
      connections: InboundConnections;
      projectRoot: string;
      consumerAuthorization?: ConsumerAuthorization | undefined;
      logError?: (message: string) => void;
      senderLimitPerMinute?: number;
      delivery?: ReplyDelivery;
    },
  ) {
    this.delivery =
      options.delivery ??
      new ReplyDelivery({
        service: options.service,
        projectRoot: options.projectRoot,
        ...(options.consumerAuthorization !== undefined ? { consumerAuthorization: options.consumerAuthorization } : {}),
        reply: (connectionId, to, text, key) => options.connections.reply(connectionId, to, text, key),
        ...(options.logError ? { log: options.logError } : {}),
      });
  }

  async handle(connectionId: string, headers: Headers, rawBody: string): Promise<InboundResponse> {
    const connection = this.options.connections.find(connectionId);
    if (!connection || connection.secret === undefined || !WEBHOOK_PROVIDERS.has(connection.provider)) return { status: 404 };
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
    let consumerSessionId: string | undefined;
    let identity: { boundAccountId?: string; sessionBoundAccountId?: string } | undefined;
    try {
      const admitted = await this.admitSender(message);
      if (admitted.status === "unmapped") return { status: 200, body: { unmatched: true } };
      if (admitted.status === "refused") {
        this.options.logError?.(`agent inbound ${message.provider}: sender not admitted`);
        return { status: 200, body: { ignored: true } };
      }
      if (admitted.status === "admitted") {
        consumerSessionId = admitted.consumerSessionId;
        identity = {
          boundAccountId: admitted.accountId,
          ...(admitted.sessionBoundAccountId ? { sessionBoundAccountId: admitted.sessionBoundAccountId } : {}),
        };
      }
      routed = await this.options.service.receive(this.options.projectRoot, message, identity);
      if (consumerSessionId) await this.bindSender(routed.agentId, routed.sessionId, consumerSessionId);
    } catch (error) {
      // An unbound, disabled or not-allowed sender looks the same as success to the sender; nothing is retried.
      if (isAgentError(error)) {
        // A Telegram user id is not something a person knows; the log is where an operator finds the one to allow.
        if (error.code === "agent.sender_not_allowed" && message.provider === "telegram" && message.from) {
          this.options.logError?.(`agent inbound telegram ${message.connectionId}: ignored a message from user id ${message.from}${message.fromUsername ? ` (@${message.fromUsername})` : ""}, who is not on the allow list`);
        }
        return { status: 200, body: { ignored: true } };
      }
      throw error;
    }
    if (routed.duplicate) return { status: 200, body: { duplicate: true } };
    void this.converse(routed, message, undefined, consumerSessionId);
    return { status: 200, body: { ok: true } };
  }

  private boundConversationAccount(agentId: string, sessionId: string): string | undefined {
    const auth = this.options.consumerAuthorization;
    if (!auth) return undefined;
    const binding = auth.bindingFor(sessionId);
    if (binding?.agentId !== agentId) return undefined;
    try {
      return auth.conversation(sessionId, binding.sessionId, binding.agentId).principal.accountId;
    } catch {
      return undefined;
    }
  }

  private async admitSender(
    message: AgentInboundMessage,
  ): Promise<
    | { status: "not_required" }
    | { status: "refused" }
    | { status: "unmapped" }
    | { status: "admitted"; consumerSessionId: string; accountId: string; sessionBoundAccountId?: string }
  > {
    const auth = this.options.consumerAuthorization;
    const prepared = await this.options.service.prepareInbound(this.options.projectRoot, message);
    const definition = (await this.options.service.get(this.options.projectRoot, prepared.agentId)).definition;
    const authenticated = definition?.channel?.access === "authenticated";
    if (!auth) return authenticated ? { status: "refused" } : { status: "not_required" };
    const sessionBoundAccountId = prepared.sessionId ? this.boundConversationAccount(prepared.agentId, prepared.sessionId) : undefined;
    const admission = await auth.admitChannelSender({
      agentId: prepared.agentId,
      channelConnectionId: message.connectionId,
      provider: message.provider,
      sender: message.from,
      ...(prepared.sessionId ? { conversationId: prepared.sessionId } : {}),
      ...(message.dmarcPass !== undefined ? { dmarcPass: message.dmarcPass } : {}),
      signal: AbortSignal.timeout(3_000),
    });
    if (admission.outcome === "not_required") return authenticated ? { status: "refused" } : { status: "not_required" };
    if (admission.outcome === "unmapped") {
      const noted = await this.options.service.noteInbound(this.options.projectRoot, message);
      if (!noted.duplicate && message.replyTo) {
        await this.options.connections.reply(message.connectionId, message.replyTo, admission.reply, `agent-unmapped:${message.connectionId}:${message.eventId}`).catch(() => undefined);
      }
      this.options.logError?.(`agent inbound ${message.provider}: sender not matched (${admission.reason})`);
      return { status: "unmapped" };
    }
    return {
      status: "admitted",
      consumerSessionId: admission.sessionId,
      accountId: admission.accountId,
      ...(sessionBoundAccountId ? { sessionBoundAccountId } : {}),
    };
  }

  private async bindSender(agentId: string, sessionId: string, consumerSessionId: string): Promise<void> {
    const auth = this.options.consumerAuthorization;
    if (!auth) return;
    const detail = await this.options.service.getSession(this.options.projectRoot, sessionId);
    auth.bind(sessionId, consumerSessionId, agentId, detail.session.revision);
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
    return false;
  }

  private parse(provider: string, connectionId: string, secret: string, _headers: Headers, payload: unknown): { message: AgentInboundMessage } | { ignored: true } | undefined {
    const result =
      provider === "slack"
        ? parseSlackInbound({ connectionId, signingSecret: secret }, payload)
        : parseTelegramInbound({ connectionId, secretToken: secret }, payload);
    if (!result.ok) return undefined;
    if ("ignored" in result) return { ignored: true };
    return { message: result.message };
  }

  /** After a restart: retry the turns it cut off on always-on iMessage agents, answering the same sender once. */
  async resumeInterrupted(): Promise<number> {
    const turns = await this.options.service.resumableTurns(this.options.projectRoot);
    for (const turn of turns) {
      const message: AgentInboundMessage = { provider: turn.provider as AgentInboundMessage["provider"], connectionId: turn.connectionId, eventId: `resume:${turn.turnId}`, threadId: turn.threadId, text: turn.text, from: turn.from, replyTo: turn.from };
      let consumerSessionId: string | undefined;
      try {
        const admitted = await this.admitSender(message);
        if (admitted.status === "unmapped") {
          await this.options.service.completeTurn(this.options.projectRoot, turn.turnId, { status: "failed", errorCode: "identity.sender_unmapped" });
          continue;
        }
        if (admitted.status === "refused") {
          await this.options.service.completeTurn(this.options.projectRoot, turn.turnId, { status: "failed", errorCode: "identity.verification_required" });
          continue;
        }
        if (admitted.status === "admitted") consumerSessionId = admitted.consumerSessionId;
      } catch (error) {
        await this.options.service.completeTurn(this.options.projectRoot, turn.turnId, {
          status: "failed",
          errorCode: isAgentError(error) ? error.code : "identity.verification_required",
        });
        continue;
      }
      try {
        if (consumerSessionId) await this.bindSender(turn.agentId, turn.sessionId, consumerSessionId);
      } catch (error) {
        await this.options.service.completeTurn(this.options.projectRoot, turn.turnId, {
          status: "failed",
          errorCode: isAgentError(error) ? error.code : "identity.verification_required",
        });
        continue;
      }
      void this.converse({ agentId: turn.agentId, sessionId: turn.sessionId }, message, turn.turnId, consumerSessionId);
    }
    return turns.length;
  }

  private async converse(routed: { agentId: string; sessionId: string }, message: AgentInboundMessage, resumeTurnId?: string, consumerSessionId?: string): Promise<void> {
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
        ...(consumerSessionId ? { consumerSessionId } : {}),
      });
      const turn = detail.turns.at(-1);
      const reply = [...detail.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turn?.id);
      if (!turn || !reply || !message.replyTo) return;
      // The turn only counts as succeeded once this reaches the person; failures are retried or left for a person.
      await this.delivery.deliver({
        turnId: turn.id,
        sessionId: routed.sessionId,
        connectionId: message.connectionId,
        provider: message.provider,
        replyTo: message.replyTo,
        text: assistantMessageTextForChannel(reply, message.provider, { consoleAccess: false }).slice(0, MAX_REPLY_CHARS),
      });
    } catch (error) {
      if (isAgentError(error) && error.code === "agent.limit_reached" && message.replyTo) {
        await connections.reply(message.connectionId, message.replyTo, error.message, `agent-limit:${routed.sessionId}:${message.eventId}`).catch(() => undefined);
      }
      logError?.(`agent inbound ${message.provider} turn failed: ${isAgentError(error) ? `${error.code}${error.message !== error.code ? ` (${error.message})` : ""}` : error instanceof Error ? error.message : String(error)}`);
    }
  }
}
