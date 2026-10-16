import type { AgentService, AgentSessionDetail } from "./service.js";
import { AgentConversation, type ConversationOptions, type SendTurnInput } from "./sessions.js";

/**
 * Serializes turns per session (or per agent while a session is being
 * opened) and keeps a handle on the running turn so it can be stopped.
 */
export class AgentChatController {
  private readonly turnChains = new Map<string, Promise<void>>();
  private readonly activeBySession = new Map<string, AgentConversation>();
  private readonly activeByAgent = new Map<string, AgentConversation>();

  constructor(private readonly options: ConversationOptions) {}

  private runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.turnChains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.turnChains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  send(input: SendTurnInput): Promise<AgentSessionDetail> {
    return this.runExclusive(input.sessionId ?? `agent:${input.agentId}`, async () => {
      const chat = new AgentConversation(this.options);
      if (input.sessionId) this.activeBySession.set(input.sessionId, chat);
      else this.activeByAgent.set(input.agentId, chat);
      let openedSessionId: string | undefined;
      try {
        return await chat.send({
          ...input,
          onSessionOpened: (sessionId) => {
            openedSessionId = sessionId;
            this.activeBySession.set(sessionId, chat);
            input.onSessionOpened?.(sessionId);
          },
        });
      } finally {
        const sessionId = input.sessionId ?? openedSessionId;
        if (sessionId && this.activeBySession.get(sessionId) === chat) this.activeBySession.delete(sessionId);
        if (this.activeByAgent.get(input.agentId) === chat) this.activeByAgent.delete(input.agentId);
      }
    });
  }

  /** Stop the running turn on a session. Returns false when nothing was running. */
  stop(sessionId: string): boolean {
    const chat = this.activeBySession.get(sessionId);
    if (!chat) return false;
    chat.stop();
    return true;
  }

  /** Stop a turn that is still opening its session (client left before the session id arrived). */
  stopOpening(agentId: string): boolean {
    const chat = this.activeByAgent.get(agentId);
    if (!chat) return false;
    chat.stop();
    return true;
  }
}
