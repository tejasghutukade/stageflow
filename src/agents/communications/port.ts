import type { AgentCommunicationProvider } from "../../config/loadAgent.js";
import { normalizeSender } from "./allowlist.js";

export type { AgentCommunicationProvider };

export type AgentInboundMessage = {
  provider: AgentCommunicationProvider;
  connectionId: string;
  eventId: string;
  threadId: string;
  text: string;
  /** The sender as the provider identifies them: an address, a phone number or a stable user id. */
  from?: string;
  /** The sender's current handle, where it differs from `from` (a Telegram username). Never an identity. */
  fromUsername?: string;
  /** Where a reply goes on the provider (channel id, chat id, or address). */
  replyTo?: string;
  /** AgentMail (and email channels): aligned DMARC pass on the received message. */
  dmarcPass?: boolean;
};

/** The session a message belongs to. Failures (unbound, disabled) throw AgentError. */
export type AgentInboundResult = { agentId: string; sessionId: string; duplicate: boolean };

export type AgentInboundPort = {
  receive(projectRoot: string, message: AgentInboundMessage): Promise<AgentInboundResult>;
};

export function agentThreadKey(input: {
  provider: AgentCommunicationProvider;
  connectionId: string;
  threadId: string;
}): string {
  return `${input.provider}\0${input.connectionId}\0${input.threadId}`;
}

/**
 * The key of the one session a message continues. An email thread or a Telegram chat is a conversation with one
 * person, so their key carries the sender and a second sender in the same thread gets a session of their own.
 * An iMessage thread is already its sender, and a Slack thread is shared by the people in it (a Slack direct
 * message arrives with a thread id that names its user). Undefined when a sender is needed and missing.
 */
export function sessionThreadKey(message: Pick<AgentInboundMessage, "provider" | "connectionId" | "threadId" | "from">): string | undefined {
  const base = agentThreadKey(message);
  if (message.provider === "slack") return base;
  if (!message.from) return undefined;
  if (message.provider === "imessage") return base;
  return `${base}\0${normalizeSender(message.from)}`;
}

export function inboundDedupeKey(message: Pick<AgentInboundMessage, "provider" | "eventId">): string {
  return `${message.provider}\0${message.eventId}`;
}
