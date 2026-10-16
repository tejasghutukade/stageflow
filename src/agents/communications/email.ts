import type { AgentInboundMessage } from "./port.js";
import type { AgentInboundPort } from "./port.js";

export type NormalizedAgentEmail = {
  connectionId: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
};

export function normalizeAgentEmail(input: NormalizedAgentEmail): AgentInboundMessage {
  return {
    provider: "email",
    connectionId: input.connectionId,
    eventId: `email:${input.messageId}`,
    threadId: input.threadId,
    text: input.subject.trim().length > 0 ? `${input.subject}\n\n${input.text}` : input.text,
    from: input.from,
  };
}

export type EmailDispatchInput = {
  email: NormalizedAgentEmail;
  isBound: boolean;
  port: AgentInboundPort;
  projectRoot: string;
  onTrigger?: (email: NormalizedAgentEmail) => Promise<void>;
};

export async function dispatchAgentEmail(input: EmailDispatchInput): Promise<
  | { routed: "agent"; result: Awaited<ReturnType<AgentInboundPort["receive"]>> }
  | { routed: "trigger" }
  | { routed: "none" }
> {
  if (input.onTrigger) {
    await input.onTrigger(input.email);
  }
  if (!input.isBound) {
    return { routed: input.onTrigger ? "trigger" : "none" };
  }
  const result = await input.port.receive(input.projectRoot, normalizeAgentEmail(input.email));
  return { routed: "agent", result };
}
