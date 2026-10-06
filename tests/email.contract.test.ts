import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmailAccounts, type EmailAccountInput } from "../src/email/accounts.js";
import { InMemoryEmailAdapter, LocalEmailAdapter } from "../src/email/adapter.js";
import { mailServer } from "./fixtures/mailServers.js";

const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-email-"));
  roots.push(root);
  return { root, accounts: new EmailAccounts(root) };
}
function input(imapPort = 993, smtpPort = 465): EmailAccountInput {
  return {
    displayName: "Company inbox", address: "agent@example.com",
    allowInsecureLocalDevelopment: true, connectionTimeoutMs: 1000,
    imap: { host: "127.0.0.1", port: imapPort, username: "imap-user", tls: "none", auth: { type: "password", secretRef: "env:IMAP_SECRET" } },
    smtp: { host: "127.0.0.1", port: smtpPort, username: "smtp-user", tls: "none", auth: { type: "password", secretRef: "env:SMTP_SECRET" } },
  };
}

for (const kind of ["memory", "local"] as const) {
  describe(`${kind} email account contract`, () => {
    it("tests each connection without sending or changing mailbox state", async () => {
      const { accounts } = await setup();
      const imap = await mailServer("imap");
      const smtp = await mailServer("smtp");
      cleanup.push(() => imap.close(), () => smtp.close());
      const account = accounts.create(input(imap.port, smtp.port));
      const adapter = kind === "memory" ? new InMemoryEmailAdapter(accounts) : new LocalEmailAdapter(accounts, { IMAP_SECRET: "fixture-secret", SMTP_SECRET: "fixture-secret" });
      cleanup.push(() => adapter.stop());
      const result = await adapter.testAccount(account.accountId);
      expect(result.imap?.state).toBe("ok");
      expect(result.smtp?.state).toBe("ok");
      expect(accounts.health(account.accountId)).toEqual(result);
      expect(imap.commands.some(command => ["SELECT", "STORE", "APPEND"].includes(command))).toBe(false);
      expect(smtp.commands.some(command => ["MAIL", "RCPT", "DATA"].includes(command))).toBe(false);
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    });

    it("rejects disabled and unknown accounts before unsupported operations", async () => {
      const { accounts } = await setup();
      const account = accounts.create(input());
      const adapter = kind === "memory" ? new InMemoryEmailAdapter(accounts) : new LocalEmailAdapter(accounts);
      cleanup.push(() => adapter.stop());
      await expect(adapter.search({ accountId: account.accountId, text: "unsupported" })).rejects.toMatchObject({ code: "EMAIL_SEARCH_UNSUPPORTED", unsupportedFields: ["text"] });
      accounts.update(account.accountId, { enabled: false });
      await expect(adapter.testAccount(account.accountId)).rejects.toMatchObject({ code: "EMAIL_ACCOUNT_DISABLED" });
      await expect(adapter.getMessage({ accountId: "unknown", id: "opaque" })).rejects.toMatchObject({ code: "EMAIL_ACCOUNT_NOT_FOUND" });
      await expect(adapter.start(async () => {})).resolves.toBeUndefined();
      expect(adapter.events.health()).toEqual([]);
    });
  });
}

describe("email configuration and real connection faults", () => {
  it("tests IMAP and SMTP separately and reports rejected credentials safely", async () => {
    const { accounts } = await setup();
    const imap = await mailServer("imap");
    const smtp = await mailServer("smtp", { rejectAuth: true });
    cleanup.push(() => imap.close(), () => smtp.close());
    const account = accounts.create(input(imap.port, smtp.port));
    const adapter = new LocalEmailAdapter(accounts, { IMAP_SECRET: "fixture-secret", SMTP_SECRET: "fixture-secret" });
    cleanup.push(() => adapter.stop());
    const receiving = await adapter.testAccount(account.accountId, "imap");
    expect(receiving.imap?.state).toBe("ok");
    expect(receiving.smtp).toBeUndefined();
    expect(smtp.commands).toEqual([]);
    const sending = await adapter.testAccount(account.accountId, "smtp");
    expect(sending.imap).toBeUndefined();
    expect(sending.smtp?.error?.code).toBe("EMAIL_AUTH_FAILED");
    expect(JSON.stringify(sending)).not.toContain("fixture-secret");
  });

  it("cancels active connections when account settings change", async () => {
    const { accounts } = await setup();
    const smtp = await mailServer("smtp", { stall: true });
    cleanup.push(() => smtp.close());
    const account = accounts.create(input(1, smtp.port));
    const adapter = new LocalEmailAdapter(accounts, { SMTP_SECRET: "fixture-secret" });
    cleanup.push(() => adapter.stop());
    const testing = adapter.testAccount(account.accountId, "smtp");
    await expect.poll(() => smtp.sockets.size).toBe(1);
    accounts.update(account.accountId, { displayName: "Updated inbox" });
    await expect(testing).rejects.toMatchObject({ code: "EMAIL_CONNECTION_FAILED" });
    await expect.poll(() => smtp.sockets.size).toBe(0);
    expect(accounts.health(account.accountId)).toBeUndefined();
  });

  it("requires STARTTLS rather than sending credentials to a server without TLS", async () => {
    const { accounts } = await setup();
    const imap = await mailServer("imap");
    const smtp = await mailServer("smtp");
    cleanup.push(() => imap.close(), () => smtp.close());
    const config = input(imap.port, smtp.port);
    const account = accounts.create({ ...config, imap: { ...config.imap, tls: "starttls" }, smtp: { ...config.smtp, tls: "starttls" } });
    const adapter = new LocalEmailAdapter(accounts, { IMAP_SECRET: "fixture-secret", SMTP_SECRET: "fixture-secret" });
    cleanup.push(() => adapter.stop());
    const result = await adapter.testAccount(account.accountId);
    expect(result.imap?.state).toBe("failed");
    expect(result.smtp?.state).toBe("failed");
    expect(imap.commands).not.toContain("AUTHENTICATE");
    expect(smtp.commands).not.toContain("AUTH");
  });

  it("persists identifiers, rotated secret references and installation scope", async () => {
    const { root, accounts } = await setup();
    const first = accounts.create(input());
    const second = accounts.create({ ...input(), address: "second@example.com" });
    const changed = accounts.update(first.accountId, { imap: { ...first.imap, auth: { type: "password", secretRef: "env:ROTATED" } } });
    expect(changed.accountId).toBe(first.accountId);
    expect(new EmailAccounts(root).get(first.accountId).imap.auth.secretRef).toBe("env:ROTATED");
    expect(accounts.get(second.accountId).imap.auth.secretRef).toBe("env:IMAP_SECRET");
    expect((await setup()).accounts.list()).toEqual([]);
    const saved = await readFile(path.join(root, ".stageflow", "email-accounts.json"), "utf8");
    expect(saved).not.toContain("fixture-secret");
    accounts.remove(first.accountId);
    expect(new EmailAccounts(root).list()).toHaveLength(1);
  });

  it("requires secure connections unless explicit loopback development is selected", async () => {
    const { accounts } = await setup();
    expect(() => accounts.create({ ...input(), allowInsecureLocalDevelopment: false })).toThrow("EMAIL_INVALID_INPUT");
    expect(() => accounts.create({ ...input(), imap: { ...input().imap, host: "mail.example.com" } })).toThrow("EMAIL_INVALID_INPUT");
    expect(() => accounts.create({ ...input(), password: "secret" })).toThrow("EMAIL_INVALID_INPUT");
    expect(() => accounts.create({ ...input(), scope: "another" })).toThrow("EMAIL_INVALID_INPUT");
  });

  it("normalizes partial failures, missing credentials and expired tokens", async () => {
    const { accounts } = await setup();
    const smtp = await mailServer("smtp");
    cleanup.push(() => smtp.close());
    const account = accounts.create(input(1, smtp.port));
    const adapter = new LocalEmailAdapter(accounts, { SMTP_SECRET: "fixture-secret" });
    cleanup.push(() => adapter.stop());
    const result = await adapter.testAccount(account.accountId);
    expect(result.imap?.error?.code).toBe("EMAIL_AUTH_FAILED");
    expect(result.smtp?.state).toBe("ok");
    accounts.update(account.accountId, { imap: { ...account.imap, auth: { type: "oauth2", secretRef: "env:TOKEN", expiresAt: "2000-01-01T00:00:00Z" } } });
    expect((await adapter.testAccount(account.accountId, "imap")).imap?.error?.code).toBe("EMAIL_TOKEN_EXPIRED");
  });

  it("closes stalled sockets at the deadline", async () => {
    const { accounts } = await setup();
    const imap = await mailServer("imap", { stall: true });
    const smtp = await mailServer("smtp", { stall: true });
    cleanup.push(() => imap.close(), () => smtp.close());
    const account = accounts.create({ ...input(imap.port, smtp.port), connectionTimeoutMs: 100 });
    const adapter = new LocalEmailAdapter(accounts, { IMAP_SECRET: "secret", SMTP_SECRET: "secret" });
    cleanup.push(() => adapter.stop());
    const result = await adapter.testAccount(account.accountId);
    expect(result.imap?.error?.code).toBe("EMAIL_TIMEOUT");
    expect(result.smtp?.error?.code).toBe("EMAIL_TIMEOUT");
    await expect.poll(() => imap.sockets.size + smtp.sockets.size).toBe(0);
  });
});
