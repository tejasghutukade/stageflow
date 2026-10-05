import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startUiServer } from "../src/server/http.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";

describe("host email account management", () => {
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
