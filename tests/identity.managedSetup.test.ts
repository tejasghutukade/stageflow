import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const TOKEN = "d".repeat(32);

async function host() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-managed-identity-"));
  bindStageflowHomeForTests(home);
  const store = createRunStore({ rootDir: home });
  const started = await startUiServer({
    agent: scriptedFakeAgent([]), cwd: home, rootDir: home, store, port: 0, uiDistDir: path.join(home, "missing"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: TOKEN }),
    agentConversationBackend: scriptedBackend(async () => "ok"),
  });
  cleanups.push(async () => {
    await closeServer(started.server);
    await store.close();
    await rm(home, { recursive: true, force: true });
  });
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, endpoint: string, body?: unknown, origin: string | null = base) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { base, admin, home };
}

describe("managed consumer identity on a running Host", () => {
  it("answers setup_required, then works the moment an operator enables it, with no restart", async () => {
    const { admin } = await host();
    expect(await admin("GET", "/api/identity/connections")).toEqual({ status: 503, body: { code: "identity.setup_required" } });
    expect((await admin("GET", "/api/identity/setup")).body).toMatchObject({ mode: "managed", enabled: false, workspaceId: "local" });

    expect((await admin("POST", "/api/identity/setup/enable")).body).toMatchObject({ enabled: true });
    const listed = await admin("GET", "/api/identity/connections");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ workspaceId: "local", connections: [] });

    const registered = await admin("POST", "/api/identity/connections/service", { id: "nightly", accountId: "acct", scope: "own", agents: ["support"] });
    expect(registered.status).toBe(201);
    expect((await admin("GET", "/api/identity/assignments")).body.assignments).toHaveLength(1);

    expect((await admin("POST", "/api/identity/setup/disable")).body).toMatchObject({ enabled: false });
    expect((await admin("GET", "/api/identity/connections")).status).toBe(503);
  });

  it("keeps the same chat boundary closed while identity is off and opens it once enabled", async () => {
    const { admin, base } = await host();
    const made = await admin("POST", "/api/agents", { definition: { id: "support", name: "Support", instructions: "Help.", enabled: true,
      tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 120 } } });
    expect(made.status).toBe(201);
    await admin("POST", "/api/agents/support/enable");
    const slug = made.body.definition.web_chat.slug as string;
    const admit = () => fetch(`${base}/api/public/chat/${slug}/admission`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "shop", assertion: "x.y.z" }),
    });
    const off = await admit();
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: "identity.setup_required" });

    await admin("POST", "/api/identity/setup/enable");
    const on = await admit();
    expect(on.status).not.toBe(503);
    expect(on.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses setup changes that carry no Origin, so a script on another site cannot flip them", async () => {
    const { admin } = await host();
    const reply = await admin("POST", "/api/identity/setup/enable", undefined, null);
    expect(reply.status).toBe(403);
    expect((await admin("GET", "/api/identity/setup")).body.enabled).toBe(false);
  });

  it("needs the control token", async () => {
    const { base } = await host();
    const response = await fetch(`${base}/api/identity/setup`);
    expect(response.status).toBe(401);
  });
});
