import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/agents/store.js";
import { agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const session = (id: string, title: string): AgentSession => ({
  id,
  agentId: "helper",
  revision: 1,
  backend: "pi",
  status: "open",
  source: "console",
  sourceRef: null,
  threadKey: null,
  title,
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
});

describe("AgentStore", () => {
  it("allows at most one pending approval per session", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store } = fixture;
    store.insertSession("p", session("ses_1", "t"));
    const approval = {
      sessionId: "ses_1",
      turnId: null,
      tool: "slack.post_message",
      payload: {},
      payloadHash: "h",
      status: "pending" as const,
      createdAt: "2026-10-15T12:00:00.000Z",
      expiresAt: "2026-10-15T12:30:00.000Z",
      decidedAt: null,
      actor: null,
    };
    store.insertApproval({ ...approval, id: "appr_1" });
    expect(() => store.insertApproval({ ...approval, id: "appr_2" })).toThrow(/UNIQUE/);
  });

  it("treats % and _ in a session search literally", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store } = fixture;
    store.insertSession("p", session("ses_1", "100% done"));
    store.insertSession("p", session("ses_2", "1000 done"));
    const found = store.listSessions("p", "helper", { limit: 10, search: "100%" });
    expect(found.sessions.map((row) => row.id)).toEqual(["ses_1"]);
  });

  it("numbers messages and turns per session", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store } = fixture;
    store.insertSession("p", session("ses_1", "t"));
    store.insertSession("p", session("ses_2", "t"));
    const base = { turnId: null, role: "user" as const, author: null, text: "x", createdAt: "2026-10-15T12:00:00.000Z" };
    store.appendMessage({ ...base, id: "m1", sessionId: "ses_1" });
    store.appendMessage({ ...base, id: "m2", sessionId: "ses_2" });
    expect(store.appendMessage({ ...base, id: "m3", sessionId: "ses_1" }).seq).toBe(2);
    expect(store.listMessages("ses_2").map((message) => message.seq)).toEqual([1]);
  });
});
