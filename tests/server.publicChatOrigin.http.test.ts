import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const VISITOR = "visitor_aaaaaaaaaaaa";
const LISTED_ORIGIN = "https://site.example";
const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];
const savedPublicOrigins = process.env.STAGEFLOW_PUBLIC_CHAT_ORIGINS;

afterEach(async () => {
  if (savedPublicOrigins === undefined) delete process.env.STAGEFLOW_PUBLIC_CHAT_ORIGINS;
  else process.env.STAGEFLOW_PUBLIC_CHAT_ORIGINS = savedPublicOrigins;
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startHost() {
  process.env.STAGEFLOW_PUBLIC_CHAT_ORIGINS = LISTED_ORIGIN;
  const home = await mkdtemp(path.join(tmpdir(), "sf-pubchat-origin-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-pubchat-origin-project-"));
  dirs.push(home, project);
  await mkdir(path.join(project, "agents"));
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    agentConversationBackend: scriptedBackend(),
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const port = address.port;
  const hostHeader = `127.0.0.1:${port}`;
  const base = `http://${hostHeader}`;
  return { base, port, hostHeader };
}

describe("public chat Host gate", () => {
  it("allows OPTIONS and POST from a configured public-chat origin at the HTTP server", async () => {
    const { base, hostHeader } = await startHost();
    const adminHeaders = {
      Authorization: `Bearer ${DRIVE}`,
      "Content-Type": "application/json",
      Host: hostHeader,
    };
    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        definition: { id: "helper", name: "Helper", instructions: "Help.", greeting: "Hi" },
      }),
    });
    expect(created.status).toBe(201);
    const slug = (await created.json() as { definition: { web_chat: { slug: string } } }).definition.web_chat.slug;
    await fetch(`${base}/api/agents/helper/enable`, { method: "POST", headers: adminHeaders });

    const corsHeaders = {
      Origin: LISTED_ORIGIN,
      Host: hostHeader,
    };
    const options = await fetch(`${base}/api/public/chat/${slug}`, {
      method: "OPTIONS",
      headers: corsHeaders,
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(LISTED_ORIGIN);

    const posted = await fetch(`${base}/api/public/chat/${slug}/threads`, {
      method: "POST",
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "x-visitor-id": VISITOR,
      },
    });
    expect(posted.status).toBe(201);

    // The Host's Origin rule is skipped for public chat, so the chat's own list must refuse other sites.
    const unlisted = await fetch(`${base}/api/public/chat/${slug}/threads`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Host: hostHeader, "Content-Type": "application/json", "x-visitor-id": VISITOR },
    });
    expect(unlisted.status).toBe(403);
    expect(((await unlisted.json()) as { code: string }).code).toBe("web_chat.forbidden_origin");
  });

  it("still rejects the same cross-origin on /api/runs", async () => {
    const { base, port, hostHeader } = await startHost();
    const { request } = await import("node:http");
    const crossOrigin = await new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/runs",
          method: "GET",
          headers: {
            Host: hostHeader,
            Origin: LISTED_ORIGIN,
            Authorization: `Bearer ${DRIVE}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error).toBe("Forbidden origin");

    const health = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${DRIVE}`, Origin: LISTED_ORIGIN, Host: hostHeader },
    });
    expect(health.status).toBe(403);
  });

  it("rejects a localhost page on another port calling /api/runs", async () => {
    const { port, hostHeader } = await startHost();
    const { request } = await import("node:http");
    const mismatch = await new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/runs",
          method: "GET",
          headers: {
            Host: hostHeader,
            Origin: "http://localhost:5173",
            Authorization: `Bearer ${DRIVE}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe("Forbidden origin");
  });
});
