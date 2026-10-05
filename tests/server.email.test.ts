import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startUiServer } from "../src/server/http.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { EmailAccounts } from "../src/email/accounts.js";
import { InMemoryEmailAdapter } from "../src/email/adapter.js";
import { EmailError } from "../src/email/port.js";
import { handleEmailRoutes } from "../src/server/emailRoutes.js";
import { emailHostFor } from "../src/email/host.js";
import { mailServer } from "./fixtures/mailServers.js";

describe("host email account management", () => {
  it("owns incoming connections for the server lifetime and exposes safe metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-email-http-receive-"));
    const fixture = await mailServer("imap");
    process.env.SF_FIXTURE_MAIL_SECRET = "fixture-secret";
    const connection = { host: "127.0.0.1", port: fixture.port, username: "user", tls: "none", auth: { type: "password", secretRef: "env:SF_FIXTURE_MAIL_SECRET" } };
    new EmailAccounts(root).create({ displayName: "Inbox", address: "agent@example.com", imap: connection, smtp: connection, allowInsecureLocalDevelopment: true });
    const host = await startUiServer({ cwd: root, rootDir: root, port: 0, agent: scriptedFakeAgent({}), uiDistDir: path.join(root, "no-ui") });
    try {
      expect(fixture.sockets.size).toBe(1);
      fixture.mailbox.messages.push({ uid: 1, source: Buffer.from("Subject: New mail\r\n\r\nPRIVATE BODY"), flags: new Set(), receivedAt: new Date() }); fixture.signal();
      await expect.poll(() => emailHostFor(root).mailbox.events.list().length).toBe(1);
      const watchers = await (await fetch(`${host.url}/api/email/watchers`)).json();
      expect(watchers.watchers[0]).toMatchObject({ folder: "INBOX", state: "watching" });
      const events = await (await fetch(`${host.url}/api/email/events`)).text();
      expect(events).toContain("New mail"); expect(events).not.toContain("PRIVATE BODY"); expect(events).not.toContain("fixture-secret");
    } finally {
      await new Promise<void>(resolve => host.server.close(() => resolve()));
      await expect.poll(() => fixture.sockets.size).toBe(0);
      await fixture.close(); delete process.env.SF_FIXTURE_MAIL_SECRET; await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves named unsupported fields in an HTTP operation error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-email-http-errors-"));
    const accounts = new EmailAccounts(root);
    const adapter = new InMemoryEmailAdapter(accounts);
    // The account-test route uses the same normalized error response as other host operations.
    vi.spyOn(adapter, "testAccount").mockRejectedValue(new EmailError("EMAIL_SEARCH_UNSUPPORTED", false, ["text", "hasAttachments"]));
    const server = createServer((req, res) => { void handleEmailRoutes(req, res, "/api/email/accounts/fixture/test", accounts, adapter); });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/email/accounts/fixture/test`, { method: "POST", body: "{}" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "EMAIL_SEARCH_UNSUPPORTED", retryable: false, unsupportedFields: ["text", "hasAttachments"] });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await adapter.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("manages and tests scoped accounts with loopback access and origin protection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-email-http-"));
    const host = await startUiServer({ cwd: root, rootDir: root, port: 0, agent: scriptedFakeAgent({}), uiDistDir: path.join(root, "no-ui") });
    const endpoint = `${host.url}/api/email/accounts`;
    const config = {
      displayName: "Mailbox", address: "agent@example.com",
      imap: { host: "imap.example.com", port: 993, username: "agent", auth: { type: "password", secretRef: "env:MISSING_IMAP" } },
      smtp: { host: "smtp.example.com", port: 465, username: "agent", auth: { type: "password", secretRef: "env:MISSING_SMTP" } },
    };
    async function request(url: string, method = "GET", body?: unknown, origin: string | null = host.url) {
      const response = await fetch(url, { method, headers: {
        "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    try {
      expect((await request(endpoint, "POST", config, null)).status).toBe(403);
      expect((await request(endpoint, "POST", config, "https://evil.example")).status).toBe(403);
      expect((await request(endpoint, "GET", undefined, "https://evil.example")).status).toBe(403);
      const created = await request(endpoint, "POST", config);
      expect(created.status).toBe(201);
      const id = created.body.accountId;
      expect(created.body.folders).toEqual(["INBOX"]);
      expect((await request(endpoint)).body.accounts).toHaveLength(1);
      expect((await request(`${endpoint}/${id}`)).body.accountId).toBe(id);
      const result = await request(`${endpoint}/${id}/test`, "POST", { protocol: "imap" });
      expect(result.status).toBe(200);
      expect(result.body.imap.error.code).toBe("EMAIL_AUTH_FAILED");
      expect(result.body.smtp).toBeUndefined();
      expect((await request(`${endpoint}/${id}/health`)).body.health).toEqual(result.body);
      expect((await request(`${endpoint}/${id}`, "PATCH", { accountId: "changed" })).status).toBe(400);
      expect((await request(`${endpoint}/${id}`, "PATCH", { enabled: false })).body.enabled).toBe(false);
      expect((await request(`${endpoint}/${id}/test`, "POST", {})).body.code).toBe("EMAIL_ACCOUNT_DISABLED");
      expect((await request(`${endpoint}/${id}`, "DELETE")).status).toBe(200);
      expect((await request(`${endpoint}/${id}`)).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => host.server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
