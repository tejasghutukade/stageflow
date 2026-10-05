import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";

const captured = vi.hoisted(() => ({ calls: [] as { tools: string[]; customTools: { name: string }[] }[] }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: async (options: { tools: string[]; customTools: { name: string }[] }) => {
    captured.calls.push(options);
    throw new Error("Stop before model execution");
  } };
});
const roots: string[] = [];
afterEach(async () => { captured.calls = []; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("Pi email tool registration", () => {
  it("registers send only for a permitted operation with host wiring", async () => {
    for (const permissions of [undefined, [{ accountId: "company", operations: ["search" as const] }], [{ accountId: "company", operations: ["send" as const] }]]) {
      const root = await mkdtemp(path.join(tmpdir(), "sf-email-tools-")); roots.push(root);
      const handle = new PiAgentAdapter().openStage({ roots: buildStageRoots(root, "notify"),
        stage: { id: "notify", model: "anthropic/claude-sonnet-4-5", system_prompt: "notify", email: permissions },
        task: { id: "notice", goal: "notify" }, priorEnvelope: null,
        email: { async send() { throw new Error("not called"); } } });
      await handle.next(); await handle.close();
      const latest = captured.calls.at(-1)!;
      const allowed = permissions?.[0].operations[0] === "send";
      expect(latest.tools.includes("send_email")).toBe(allowed);
      expect(latest.customTools.some(tool => tool.name === "send_email")).toBe(allowed);
    }
  });
});
