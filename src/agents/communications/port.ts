import type { AgentCommunicationProvider } from "../../config/loadAgent.js";

export type { AgentCommunicationProvider };

export type AgentInboundMessage = {
  provider: AgentCommunicationProvider;
  connectionId: string;
  eventId: string;
  threadId: string;
  text: string;
  from?: string;
  /** Where a reply goes on the provider (channel id, chat id, or address). */
  replyTo?: string;
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

export function inboundDedupeKey(message: Pick<AgentInboundMessage, "provider" | "eventId">): string {
  return `${message.provider}\0${message.eventId}`;
}
