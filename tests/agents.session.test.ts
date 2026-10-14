import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agents/service.js";
import {
  AgentConversation,
  type ConversationBackend,
} from "../src/agents/sessions.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { listWorkshopSessions } from "../src/workshop/sessionStore.js";

afterEach(() => {
  resetGlobalStageflowHomeForTests();
});

function recordingBackend(id: "pi" | "claude", reply: string): ConversationBackend & {
  seen: string[];
  calls: number;
} {
  const backend = {
    id,
    seen: [] as string[],
    calls: 0,
    async complete(input: { instructions: string; signal: AbortSignal; onDelta: (text: string) => void }) {
      backend.calls += 1;
      backend.seen.push(input.instructions);
      if (input.signal.aborted) return { text: "" };
      input.onDelta(reply);
      return { text: reply };
    },
  };
  return backend;
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-agents-session-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-agents-session-project-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  return { home, project, service: new AgentService({ homeDir: home }) };
}

describe("agent sessions", () => {
  it("pins a session to the revision that started it", async () => {
    const { project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Revision one",
    });
    const enabled = await service.setEnabled(project, created.id, true);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const backend = recordingBackend("pi", "Answer");
    const chat = new AgentConversation({ service, backend });

    const first = await chat.send({ projectRoot: project, agentId: created.id, text: "Hello" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await service.save(project, created.id, {
      baseRevision: enabled.agent.revision,
      name: "Research assistant",
      instructions: "Revision two",
    });
    const second = await chat.send({
      projectRoot: project,
      agentId: created.id,
      sessionId: first.session.id,
      text: "Again",
    });
    expect(second.ok).toBe(true);
    expect(backend.seen).toEqual(["Revision one", "Revision one"]);
    expect((await service.getSession(project, first.session.id))?.revision).toBe(enabled.agent.revision);
  });

  it("saves a partial reply when the turn is stopped", async () => {
    const { project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Stay brief",
    });
    await service.setEnabled(project, created.id, true);
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        input.onDelta("Partial");
        started();
        const winner = await Promise.race([
          gate.then((text) => ({ aborted: false, text })),
          new Promise<{ aborted: true }>((resolve) => {
            input.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
          }),
        ]);
        return { text: winner.aborted ? "Partial" : winner.text };
      },
    };
    const chat = new AgentConversation({ service, backend });
    const pending = chat.send({ projectRoot: project, agentId: created.id, text: "Start" });
    await ready;
    await chat.stop();
    release("Finished");
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = await service.getSession(project, result.session.id);
    expect(session?.status).toBe("open");
    expect(session?.messages.map((message) => message.text)).toEqual(["Start", "Partial"]);
  });

  it("reloads the transcript and pin in a new process", async () => {
    const { home, project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Pinned",
    });
    const enabled = await service.setEnabled(project, created.id, true);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const chat = new AgentConversation({ service, backend: recordingBackend("claude", "Saved") });
    const sent = await chat.send({ projectRoot: project, agentId: created.id, text: "Remember" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const reloaded = new AgentConversation({
      service: new AgentService({ homeDir: home }),
      backend: recordingBackend("claude", "Next"),
    });
    const session = await reloaded.session(project, sent.session.id);
    expect(session?.revision).toBe(enabled.agent.revision);
    expect(session?.messages.map((message) => message.text)).toEqual(["Remember", "Saved"]);
  });

  it("rejects a disabled agent before calling the model", async () => {
    const { project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Wait",
    });
    await service.setEnabled(project, created.id, true);
    const backend = recordingBackend("pi", "No");
    const chat = new AgentConversation({ service, backend });
    const opened = await chat.send({ projectRoot: project, agentId: created.id, text: "One" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await service.setEnabled(project, created.id, false);
    const denied = await chat.send({
      projectRoot: project,
      agentId: created.id,
      sessionId: opened.session.id,
      text: "Two",
    });
    expect(denied).toEqual({ ok: false, code: "agent.disabled" });
    expect(backend.calls).toBe(1);
  });

  it("stores the same session shape for Pi and Claude", async () => {
    const { home, project, service } = await fixture();
    const created = await service.create(project, {
      id: "research_assistant",
      name: "Research assistant",
      instructions: "Same",
    });
    await service.setEnabled(project, created.id, true);
    const shapes = [];
    for (const id of ["pi", "claude"] as const) {
      const chat = new AgentConversation({ service, backend: recordingBackend(id, id) });
      const sent = await chat.send({ projectRoot: project, agentId: created.id, text: id });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      const session = await service.getSession(project, sent.session.id);
      shapes.push(session ? Object.keys(session).sort() : []);
    }
    expect(shapes[0]).toEqual(shapes[1]);
    expect(listWorkshopSessions(home)).toEqual([]);
  });
});
