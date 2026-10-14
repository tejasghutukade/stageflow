import { randomBytes } from "node:crypto";
import type { AgentService } from "./service.js";
import type { AgentMessage, AgentSessionRecord } from "./store.js";

export type ConversationBackend = {
  id: "pi" | "claude";
  complete(input: {
    instructions: string;
    messages: AgentMessage[];
    signal: AbortSignal;
    onDelta: (text: string) => void;
  }): Promise<{ text: string }>;
};

export type SendTurnInput = {
  projectRoot: string;
  agentId: string;
  sessionId?: string;
  text: string;
  onDelta?: (text: string) => void;
};

export type SendTurnResult =
  | { ok: true; session: AgentSessionRecord }
  | { ok: false; code: string };

export class AgentConversation {
  private controller: AbortController | null = null;

  constructor(
    private readonly options: { service: AgentService; backend: ConversationBackend },
  ) {}

  async stop(): Promise<void> {
    this.controller?.abort();
  }

  async session(projectRoot: string, sessionId: string): Promise<AgentSessionRecord | undefined> {
    return this.options.service.getSession(projectRoot, sessionId);
  }

  async send(input: SendTurnInput): Promise<SendTurnResult> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      let sessionId = input.sessionId;
      if (!sessionId) {
        const opened = await this.options.service.openSession(input.projectRoot, input.agentId);
        if (!opened.ok) return opened;
        sessionId = opened.session.id;
      }
      const started = await this.options.service.startTurn(input.projectRoot, sessionId);
      if (!started.ok) return started;
      const session = await this.options.service.getSession(input.projectRoot, sessionId);
      if (!session) return { ok: false, code: "agent.session_not_found" };
      const revision = await this.options.service.revision(
        input.projectRoot,
        session.agentId,
        session.revision,
      );
      if (!revision) return { ok: false, code: "agent.revision_not_found" };
      const result = await this.options.backend.complete({
        instructions: revision.instructions,
        messages: session.messages,
        signal: controller.signal,
        onDelta: input.onDelta ?? (() => undefined),
      });
      const saved = await this.options.service.appendTurn(input.projectRoot, sessionId, {
        backend: this.options.backend.id,
        status: "open",
        messages: [
          { id: `msg_${randomBytes(6).toString("hex")}`, role: "user", text: input.text },
          { id: `msg_${randomBytes(6).toString("hex")}`, role: "assistant", text: result.text },
        ],
      });
      if (!saved) return { ok: false, code: "agent.session_not_found" };
      return { ok: true, session: saved };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
