import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { EmailAccounts, resolveEmailSecret, type EmailAccountInput } from "../src/email/accounts.js";
import { InMemoryEmailAdapter } from "../src/email/adapter.js";
import { emailHostFor, emailWorkerEnvironment, stageEmail, validateStageEmailAccounts } from "../src/email/host.js";
import { startUiServer } from "../src/server/http.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { mailServer } from "./fixtures/mailServers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-email-yaml-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function input(): EmailAccountInput {
  return { displayName: "Company inbox", address: "agent@example.com",
    imap: { host: "imap.example.com", port: 993, username: "receive-user", auth: { type: "password", secretRef: "env:RECEIVE_SECRET" } },
    smtp: { host: "smtp.example.com", port: 587, username: "send-user", tls: "starttls", auth: { type: "password", secretRef: "env:SEND_SECRET" } } };
}
async function configure(root: string, accounts: unknown[]): Promise<void> {
  await writeFile(path.join(root, "email.yaml"), stringify({ version: 1, accounts }, { aliasDuplicateObjects: false }));
}
function savedPath(root: string): string { return path.join(root, ".stageflow", "email-accounts.json"); }

describe("email.yaml account startup", () => {
  it("keeps inline passwords out of account responses and persisted state", async () => {
    const root = await workspace();
    const account = { ...input(), accountId: "personal" };
    await configure(root, [{ ...account,
      imap: { ...account.imap, auth: { type: "password", password: "inline-receive-secret" } },
      smtp: { ...account.smtp, auth: { type: "password", secretRef: "inline-send-secret" } },
    }]);
    const accounts = new EmailAccounts(root);
    const loaded = accounts.get("personal");
    expect(resolveEmailSecret(loaded.imap, {})).toBe("inline-receive-secret");
    expect(resolveEmailSecret(loaded.smtp, {})).toBe("inline-send-secret");
    expect(JSON.stringify(accounts.list())).not.toContain("inline-receive-secret");
    expect(JSON.stringify(accounts.list())).not.toContain("inline-send-secret");
    const persisted = await readFile(savedPath(root), "utf8");
    expect(persisted).not.toContain("inline-receive-secret");
    expect(persisted).not.toContain("inline-send-secret");
    expect(resolveEmailSecret(new EmailAccounts(root).get("personal").smtp, {})).toBe("inline-send-secret");
  });
  it("normalizes only grouped Gmail app passwords", async () => {
    const root = await workspace();
    const account = input();
    await configure(root, [{ ...account, accountId: "personal",
      smtp: { ...account.smtp, host: "smtp.gmail.com", auth: { type: "password", password: "abcd efgh ijkl mnop" } },
      imap: { ...account.imap, auth: { type: "password", password: "abcd efgh ijkl mnop" } },
    }]);
    const loaded = new EmailAccounts(root).get("personal");
    expect(resolveEmailSecret(loaded.smtp, {})).toBe("abcdefghijklmnop");
    expect(resolveEmailSecret(loaded.imap, {})).toBe("abcd efgh ijkl mnop");
  });
  it("loads multiple stable IDs, preserves defaults and all account settings", async () => {
    const root = await workspace();
    const full = { ...input(), accountId: "support-inbox", enabled: false, displayName: "Support", address: "support@example.com",
      adapter: "local", folders: ["INBOX", "Requests"], senderAliases: ["alias@example.com"], pollingIntervalMs: 12000,
      connectionTimeoutMs: 13000, reconnectMaxDelayMs: 14000, searchWorkLimit: 1500,
      sentFolder: "Sent", sentCopyPolicy: "imap-append", sentCopyMaxBytes: 16000,
      attachmentLimits: { count: 2, perFileBytes: 1000, totalBytes: 2000, downloadBytes: 3000 },
      imap: { ...input().imap, auth: { type: "oauth2", secretRef: "env:MAIL_TOKEN", expiresAt: "2027-01-01T00:00:00Z" } } };
    await configure(root, [{ ...input(), accountId: "company-inbox" }, full]);
    const accounts = new EmailAccounts(root);
    expect(accounts.get("company-inbox")).toMatchObject({ accountId: "company-inbox", folders: ["INBOX"], enabled: true,
      imap: { tls: "implicit" }, smtp: { tls: "starttls" }, sentCopyPolicy: "provider-managed" });
    expect(accounts.get("support-inbox", false)).toMatchObject(full);
    expect(new EmailAccounts(root).list()).toEqual(accounts.list());
    expect(JSON.parse(await readFile(savedPath(root), "utf8")).yamlManagedAccountIds).toEqual(["company-inbox", "support-inbox"]);
    expect((await stat(savedPath(root))).mode & 0o777).toBe(0o600);
    const stage = { id: "inspect", model: "test", system_prompt: "Inspect", email: [{ accountId: "company-inbox", operations: ["search" as const] }] };
    validateStageEmailAccounts(accounts, stage);
    expect(emailWorkerEnvironment({ RECEIVE_SECRET: "private", SEND_SECRET: "private", MAIL_TOKEN: "private", MODEL_KEY: "retained" }, accounts)).toEqual({ MODEL_KEY: "retained" });
    const adapter = new InMemoryEmailAdapter(accounts); cleanup.push(() => adapter.stop());
    expect(await stageEmail(adapter, stage, "run").search({ accountId: "company-inbox" })).toEqual({ messages: [] });
  });
  it("preserves HTTP accounts when the file is absent and prevents file ownership conflicts", async () => {
    const root = await workspace();
    const original = new EmailAccounts(root);
    const http = original.create(input());
    expect(new EmailAccounts(root).list()).toEqual([http]);
    const before = await readFile(savedPath(root), "utf8");
    await configure(root, [{ ...input(), accountId: "new-file-account" }, { ...input(), accountId: http.accountId }]);
    expect(() => new EmailAccounts(root)).toThrow("EMAIL_OPERATION_CONFLICT");
    expect(await readFile(savedPath(root), "utf8")).toBe(before);
    expect(original.list()).toEqual([http]);
  });
  it("syncs edits and removals once, preserves other accounts and does not reload an active instance", async () => {
    const root = await workspace();
    const http = new EmailAccounts(root).create(input());
    await configure(root, [{ ...input(), accountId: "company-inbox" }, { ...input(), accountId: "support-inbox" }]);
    const active = new EmailAccounts(root);
    const health = { accountId: "company-inbox", checkedAt: "2026-10-05T00:00:00Z", capabilities: { operations: [], searchFields: [], idle: false } };
    active.recordHealth(health);
    active.recordHealth({ ...health, accountId: http.accountId });
    await configure(root, [{ ...input(), accountId: "company-inbox", displayName: "Updated", imap: { ...input().imap, auth: { type: "password", secretRef: "env:ROTATED" } } }]);
    expect(active.get("company-inbox").displayName).toBe("Company inbox");
    const writable = EmailAccounts.prototype as unknown as { persist(): void };
    const persist = vi.spyOn(writable, "persist");
    const updated = new EmailAccounts(root);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(updated.get("company-inbox")).toMatchObject({ displayName: "Updated", imap: { auth: { secretRef: "env:ROTATED" } } });
    expect(updated.get("support-inbox", false).enabled).toBe(false);
    expect(updated.get(http.accountId)).toEqual(http);
    expect(updated.health("company-inbox")).toBeUndefined();
    expect(updated.health(http.accountId)).toEqual({ ...health, accountId: http.accountId });
    expect(() => updated.update("support-inbox", { enabled: true })).toThrow("EMAIL_OPERATION_CONFLICT");
    expect(() => updated.remove("company-inbox")).toThrow("EMAIL_OPERATION_CONFLICT");
    persist.mockRestore();
    await configure(root, [{ ...input(), accountId: "support-inbox" }]);
    expect(new EmailAccounts(root).get("support-inbox").enabled).toBe(true);
  });
  it("disables file accounts on missing or empty files without deleting IDs", async () => {
    for (const absent of [false, true]) {
      const root = await workspace();
      const http = new EmailAccounts(root).create(input());
      await configure(root, [{ ...input(), accountId: "company-inbox" }]);
      new EmailAccounts(root);
      if (absent) await rm(path.join(root, "email.yaml")); else await configure(root, []);
      const accounts = new EmailAccounts(root);
      expect(accounts.get("company-inbox", false).enabled).toBe(false);
      expect(accounts.get(http.accountId)).toEqual(http);
      expect(() => accounts.update("company-inbox", { enabled: true })).toThrow("EMAIL_OPERATION_CONFLICT");
      expect(JSON.parse(await readFile(savedPath(root), "utf8")).yamlManagedAccountIds).toEqual(["company-inbox"]);
    }
  });
  it("makes no write or health reset for unchanged normalized settings", async () => {
    const root = await workspace();
    await configure(root, [{ ...input(), accountId: "company-inbox" }]);
    const first = new EmailAccounts(root);
    const health = { accountId: "company-inbox", checkedAt: "2026-10-05T00:00:00Z", capabilities: { operations: [], searchFields: [], idle: false } };
    first.recordHealth(health);
    const before = await readFile(savedPath(root), "utf8");
    await configure(root, [{ ...input(), accountId: "company-inbox", enabled: true, folders: ["INBOX"], sentCopyPolicy: "provider-managed" }]);
    const persist = vi.spyOn(EmailAccounts.prototype as unknown as { persist(): void }, "persist");
    const repeated = new EmailAccounts(root);
    expect(persist).not.toHaveBeenCalled(); expect(repeated.health("company-inbox")).toEqual(health);
    expect(await readFile(savedPath(root), "utf8")).toBe(before);
  });
  it("rejects malformed, duplicate, oversized, secret-bearing or unsupported input before any write", async () => {
    const root = await workspace();
    const original = new EmailAccounts(root);
    const http = original.create(input());
    const before = await readFile(savedPath(root), "utf8");
    const good = { ...input(), accountId: "company-inbox" };
    const invalid = [
      "version: 1\naccounts: [",
      "version: 1\nversion: 1\naccounts: []\n",
      stringify({ version: 2, accounts: [good] }),
      stringify({ version: 1, accounts: [good, good] }),
      stringify({ version: 1, accounts: [good, { ...good, accountId: "other", password: "PRIVATE_SECRET" }] }),
      stringify({ version: 1, accounts: [{ ...good, imap: { ...good.imap, auth: { type: "password", secretRef: "env:SECRET", password: "PRIVATE_SECRET" } } }] }),
      stringify({ version: 1, accounts: [{ ...good, accountId: "../unsafe" }] }),
      stringify({ version: 1, accounts: [{ ...good, imap: { ...good.imap, tls: "none" } }] }),
      stringify({ version: 1, accounts: [{ ...good, imap: { ...good.imap, auth: { type: "oauth2", secretRef: "env:TOKEN" } } }] }),
      "version: 1\naccounts: &accounts [*accounts]\n",
      "#".repeat(262145),
    ];
    const persist = vi.spyOn(EmailAccounts.prototype as unknown as { persist(): void }, "persist");
    for (const content of invalid) {
      await writeFile(path.join(root, "email.yaml"), content);
      let error: unknown;
      try { new EmailAccounts(root); } catch (fault) { error = fault; }
      expect(error).toBeDefined(); expect(String(error)).not.toContain("PRIVATE_SECRET");
      expect(String(error)).not.toContain(content);
      expect(await readFile(savedPath(root), "utf8")).toBe(before);
      expect(original.list()).toEqual([http]);
    }
    expect(persist).not.toHaveBeenCalled();
  });
  it("leaves durable and existing memory state unchanged if synchronization cannot persist", async () => {
    const root = await workspace();
    await configure(root, [{ ...input(), accountId: "company-inbox" }]);
    const original = new EmailAccounts(root);
    const before = await readFile(savedPath(root), "utf8");
    await configure(root, [{ ...input(), accountId: "company-inbox", displayName: "Changed" }, { ...input(), accountId: "second" }]);
    vi.spyOn(EmailAccounts.prototype as unknown as { persist(): void }, "persist").mockImplementation(() => { throw new Error("PRIVATE_SECRET"); });
    expect(() => new EmailAccounts(root)).toThrow("EMAIL_STORAGE_FAILED");
    expect(await readFile(savedPath(root), "utf8")).toBe(before);
    expect(original.list()).toHaveLength(1); expect(original.get("company-inbox").displayName).toBe("Company inbox");
  });
  it("rejects a directory as the startup file", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "email.yaml"));
    expect(() => new EmailAccounts(root)).toThrow("EMAIL_INVALID_INPUT");
  });
  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const root = await workspace();
    execFileSync("mkfifo", [path.join(root, "email.yaml")]);
    expect(() => new EmailAccounts(root)).toThrow("EMAIL_INVALID_INPUT");
  });
  it("loads the normal HTTP host and stage grants without sending or testing SMTP", async () => {
    const root = await workspace();
    const imap = await mailServer("imap"); const smtp = await mailServer("smtp");
    cleanup.push(() => imap.close(), () => smtp.close());
    const previous = process.env.SF_YAML_TEST_SECRET;
    process.env.SF_YAML_TEST_SECRET = "fixture-secret";
    cleanup.push(async () => { if (previous === undefined) delete process.env.SF_YAML_TEST_SECRET; else process.env.SF_YAML_TEST_SECRET = previous; });
    const connection = { host: "127.0.0.1", username: "agent", tls: "none", auth: { type: "password", secretRef: "env:SF_YAML_TEST_SECRET" } };
    await configure(root, [{ displayName: "Company inbox", address: "agent@example.com", accountId: "company-inbox",
      imap: { ...connection, port: imap.port }, smtp: { ...connection, port: smtp.port }, allowInsecureLocalDevelopment: true }]);
    const host = await startUiServer({ cwd: root, rootDir: root, port: 0, agent: scriptedFakeAgent({}), uiDistDir: path.join(root, "no-ui") });
    cleanup.push(() => new Promise<void>(resolve => host.server.close(() => resolve())));
    expect(imap.sockets.size).toBe(1); expect(smtp.commands).toEqual([]); expect(smtp.messages).toEqual([]);
    const response = await (await fetch(`${host.url}/api/email/accounts`)).text();
    expect(response).toContain("company-inbox"); expect(response).not.toContain("fixture-secret");
    const stage = { id: "inspect", model: "test", system_prompt: "Inspect", email: [{ accountId: "company-inbox", operations: ["search" as const] }] };
    const email = emailHostFor(root); validateStageEmailAccounts(email.accounts, stage);
    expect(await stageEmail(email.mailbox, stage, "run").search({ accountId: "company-inbox" })).toEqual({ messages: [] });
    for (const method of ["PATCH", "DELETE"]) {
      const response = await fetch(`${host.url}/api/email/accounts/company-inbox`, { method, headers: { Origin: host.url },
        ...(method === "PATCH" ? { body: JSON.stringify({ enabled: false }) } : {}) });
      expect((await response.json()).code).toBe("EMAIL_OPERATION_CONFLICT");
    }
  });
});
