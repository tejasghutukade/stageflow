import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { guardedStream } from "../src/agents/guardrails.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function agent(guardrails?: Record<string, unknown>) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  await fixture.service.create(fixture.project, agentInput("pal", guardrails ? { guardrails } : {}), { source: "console" });
  await fixture.service.setEnabled(fixture.project, "pal", true, { source: "console" });
  return fixture;
}

describe("guarded streaming", () => {
  it("streams straight through when there are no block patterns", () => {
    const seen: string[] = [];
    const stream = guardedStream({ block_patterns: [] } as never, (d) => seen.push(d));
    stream.push("a");
    expect(seen).toEqual(["a"]);
  });

  it("holds deltas until the finished reply passes, then releases them in order", () => {
    const seen: string[] = [];
    const stream = guardedStream({ block_patterns: ["secret"] } as never, (d) => seen.push(d));
    stream.push("hel");
    stream.push("lo");
    expect(seen).toEqual([]);
    expect(stream.release("hello")).toEqual({ ok: true });
    expect(seen).toEqual(["hel", "lo"]);
  });

  it("never releases text that matches, even when the pattern spans deltas", () => {
    const seen: string[] = [];
    const stream = guardedStream({ block_patterns: ["secret"] } as never, (d) => seen.push(d));
    stream.push("the sec");
    stream.push("ret code");
    expect(stream.release("the secret code")).toEqual({ ok: false, pattern: "secret" });
    expect(seen).toEqual([]);
  });

  it("blocks on what was streamed even when the final text differs", () => {
    const seen: string[] = [];
    const stream = guardedStream({ block_patterns: ["secret"] } as never, (d) => seen.push(d));
    stream.push("a secret");
    expect(stream.release("clean")).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });

  it("a guarded agent's blocked reply is never streamed to the client", async () => {
    const { service, project } = await agent({ block_patterns: ["forbidden"] });
    const chat = new AgentChatController({ service, backend: scriptedBackend(() => "this is forbidden text") });
    const deltas: string[] = [];
    await expect(chat.send({ projectRoot: project, agentId: "pal", text: "hi", onDelta: (d) => deltas.push(d) })).rejects.toMatchObject({ code: "agent.guardrail_blocked" });
    expect(deltas).toEqual([]);
  });

  it("a guarded agent's clean reply is streamed once it passes; an unguarded one streams as before", async () => {
    const guarded = await agent({ block_patterns: ["forbidden"] });
    const deltas: string[] = [];
    await new AgentChatController({ service: guarded.service, backend: scriptedBackend(() => "all good here") }).send({ projectRoot: guarded.project, agentId: "pal", text: "hi", onDelta: (d) => deltas.push(d) });
    expect(deltas.join("")).toBe("all good here");

    const open = await agent();
    const order: string[] = [];
    const backend = scriptedBackend(() => "plain reply");
    await new AgentChatController({ service: open.service, backend }).send({ projectRoot: open.project, agentId: "pal", text: "hi", onDelta: (d) => order.push(d) });
    expect(order.join("")).toBe("plain reply");
    expect(order).toHaveLength(2);
  });
});
