import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmailAccounts } from "../src/email/accounts.js";
import { InMemoryEmailAdapter, LocalEmailAdapter } from "../src/email/adapter.js";
import { EmailSubmissions } from "../src/email/submissions.js";
import { mailServer } from "./fixtures/mailServers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(kind: "local" | "memory", faults: Parameters<typeof mailServer>[1] = {}, smtpFaults: Parameters<typeof mailServer>[1] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-copy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const imap = await mailServer("imap", faults);
  const smtp = await mailServer("smtp", smtpFaults);
  cleanup.push(() => imap.close(), () => smtp.close());
  imap.mailboxes.set("Sent", { generation: "1", messages: [] });
  const connection = { host: "127.0.0.1", username: "agent", tls: "none" as const, auth: { type: "password" as const, secretRef: "env:SECRET" } };
  const accounts = new EmailAccounts(root);
  const account = accounts.create({ displayName: "Agent", address: "agent@example.com", imap: { ...connection, port: imap.port },
    smtp: { ...connection, port: smtp.port }, allowInsecureLocalDevelopment: true, connectionTimeoutMs: 300,
    sentFolder: "Sent", sentCopyPolicy: "imap-append" });
  const adapter = kind === "local" ? new LocalEmailAdapter(accounts, { SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
  if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, [], "Sent");
  cleanup.push(() => adapter.stop());
  const input = { accountId: account.accountId, operationKey: "copy", to: [{ address: "recipient@example.com" }],
    bcc: [{ address: "hidden@example.com" }], subject: "Copy subject", text: "Copy body café", inReplyTo: "<source@example.com>", references: ["<source@example.com>"] };
  return { root, accounts, account, adapter, input, imap, smtp };
}
for (const kind of ["local", "memory"] as const) describe(`${kind} sent copies`, () => {
  it("files one copy, makes it readable, and reuses the receipt after restart", async () => {
    const { accounts, adapter, input, imap, smtp, root } = await setup(kind);
    const [receipt, duplicate] = await Promise.all([adapter.send(input), adapter.send(input)]);
    expect(receipt).toEqual(duplicate);
    expect(receipt.sentCopy).toEqual({ state: "completed" });
    const search = await adapter.search({ accountId: input.accountId, mailbox: "Sent" });
    expect(search.messages).toHaveLength(1);
    const message = await adapter.getMessage(search.messages[0].ref);
    expect(message.text.trim()).toBe(input.text);
    expect(message.inReplyTo).toBe(input.inReplyTo);
    expect(message.references).toEqual(input.references);
    expect(message.messageId).toBe(receipt.messageId);
    if (kind === "local") {
      expect(imap.appendedMime).toHaveLength(1);
      expect(imap.appendedMime[0].toString()).toBe(smtp.messages[0].data);
      expect(smtp.messages[0].recipients).toContain("hidden@example.com");
      expect(smtp.messages[0].data).not.toMatch(/^Bcc:/im);
    }
    const restarted = kind === "local" ? new LocalEmailAdapter(accounts, { SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
    cleanup.push(() => restarted.stop());
    expect(await restarted.send(input)).toEqual(receipt);
    if (kind === "local") { expect(smtp.messages).toHaveLength(1); expect(imap.appendedMime).toHaveLength(1); }
    const ledger = await readFile(path.join(root, ".stageflow/email-submissions.json"), "utf8");
    expect(ledger).not.toContain(input.text); expect(ledger).not.toContain("MIME-Version"); expect(ledger).not.toContain("fixture-secret");
  });
  it("uses provider-managed filing by default and enforces MIME limits before SMTP", async () => {
    const { accounts, adapter, input, account, imap, smtp } = await setup(kind);
    accounts.update(account.accountId, { sentCopyPolicy: "provider-managed" });
    expect((await adapter.send(input)).sentCopy).toBeUndefined();
    expect(imap.appendedMime).toHaveLength(0);
    accounts.update(account.accountId, { sentCopyPolicy: "imap-append", sentCopyMaxBytes: 10 });
    await expect(adapter.send({ ...input, operationKey: "limit" })).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    if (kind === "local") expect(smtp.messages).toHaveLength(1);
  });
  it("returns SMTP success with a stable warning for a missing folder", async () => {
    const { accounts, adapter, input, account, smtp } = await setup(kind);
    accounts.update(account.accountId, { sentFolder: "Missing" });
    const receipt = await adapter.send(input);
    expect(receipt.accepted).toContain("recipient@example.com");
    expect(receipt.sentCopy).toEqual({ state: "failed", error: "EMAIL_INVALID_INPUT" });
    expect(receipt.warnings).toEqual(["EMAIL_SENT_COPY_FAILED"]);
    expect(await adapter.send(input)).toEqual(receipt);
    if (kind === "local") expect(smtp.messages).toHaveLength(1);
  });
  it("files a public reply with the same attachment and thread headers", async () => {
    const { root, adapter, input, imap, smtp } = await setup(kind);
    const source = Buffer.from("From: sender@example.com\r\nTo: agent@example.com\r\nSubject: Original\r\nMessage-ID: <original@example.com>\r\n\r\nOriginal body\r\n");
    const record = { uid: 1, source, flags: new Set<string>(), receivedAt: new Date() };
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(input.accountId, [record]);
    else imap.mailbox.messages.push(record);
    const ref = (await adapter.search({ accountId: input.accountId })).messages[0].ref;
    const context = { workspaceDir: path.join(root, "run"), stageId: "report", attempt: 1 };
    const artifact = "stages/report/attempts/1/artifacts/report.bin";
    await mkdir(path.dirname(path.join(context.workspaceDir, artifact)), { recursive: true });
    const bytes = Buffer.from([0, 255, 13, 10, 42]);
    await writeFile(path.join(context.workspaceDir, artifact), bytes);
    const receipt = await adapter.reply({ ref, operationKey: "reply", text: "Reply body", attachments: [{ artifact }] }, context);
    expect(receipt.sentCopy?.state).toBe("completed");
    const copy = (await adapter.search({ accountId: input.accountId, mailbox: "Sent" })).messages[0];
    const message = await adapter.getMessage(copy.ref);
    expect(message.subject).toBe("Re: Original"); expect(message.inReplyTo).toBe("<original@example.com>");
    const download = await adapter.downloadAttachment({ ref: copy.ref, attachmentId: "0" }, context);
    expect(await readFile(path.join(context.workspaceDir, download.artifact))).toEqual(bytes);
    if (kind === "local") {
      expect(imap.appendedMime[0].toString()).toBe(smtp.messages[0].data);
      expect((await simpleParser(imap.appendedMime[0])).attachments[0].content).toEqual(bytes);
    }
  });
});
describe("sent copy recovery", () => {
  it("checks account changes and shutdown after asynchronous MIME compilation", async () => {
    for (const action of ["change", "stop"]) {
      const { adapter, accounts, input, smtp } = await setup("local");
      const compile = MailComposer.prototype.compile;
      let stopping: Promise<void> | undefined;
      const spy = vi.spyOn(MailComposer.prototype, "compile").mockImplementation(function () {
        const message = compile.call(this);
        const stream = message.createReadStream.bind(message);
        message.createReadStream = (...args) => {
          const result = stream(...args);
          result.once("data", () => {
            if (action === "change") accounts.update(input.accountId, { displayName: "Changed during compile" });
            else stopping = adapter.stop();
          });
          return result;
        };
        return message;
      });
      try {
        await expect(adapter.send(input)).rejects.toMatchObject({ code: "EMAIL_CONNECTION_FAILED" });
        await stopping;
        expect(smtp.commands).toEqual([]);
      } finally { spy.mockRestore(); }
    }
  });
  for (const failureAt of [2, 3]) {
    it(`keeps a known SMTP receipt when ledger write ${failureAt} fails`, async () => {
      const { accounts, adapter, input, smtp, imap } = await setup("local");
      const writable = adapter.submissions as unknown as { persist(): void };
      const persist = writable.persist.bind(adapter.submissions);
      let writes = 0;
      const spy = vi.spyOn(writable, "persist").mockImplementation(() => {
        if (++writes >= failureAt) throw new Error("storage failed");
        persist();
      });
      const receipt = await adapter.send(input);
      expect(receipt.accepted).toContain("recipient@example.com");
      expect(receipt.warnings).toContain("EMAIL_STORAGE_FAILED");
      expect(receipt.sentCopy?.state).toBe(failureAt === 2 ? "unknown" : "completed");
      expect(imap.appendedMime).toHaveLength(failureAt === 2 ? 0 : 1);
      expect(await adapter.send(input)).toEqual(receipt);
      spy.mockRestore();
      const restarted = new LocalEmailAdapter(accounts, { SECRET: "fixture-secret" }); cleanup.push(() => restarted.stop());
      if (failureAt === 2) await expect(restarted.send(input)).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
      else expect((await restarted.send(input)).sentCopy?.state).toBe("unknown");
      expect(smtp.messages).toHaveLength(1); expect(imap.appendedMime).toHaveLength(failureAt === 2 ? 0 : 1);
    });
  }
  it("keeps SMTP success when account changes or shutdown cancels append", async () => {
    for (const action of ["change", "stop"]) {
      const { adapter, accounts, input, smtp, imap } = await setup("local", { stallAppend: true });
      const pending = adapter.send(input);
      await expect.poll(() => imap.appendedMime.length).toBe(1);
      if (action === "change") accounts.update(input.accountId, { displayName: "Updated" }); else await adapter.stop();
      const receipt = await pending;
      expect(receipt.accepted).toContain("recipient@example.com"); expect(receipt.sentCopy?.state).toBe("unknown");
      expect(smtp.messages).toHaveLength(1); expect(imap.appendedMime).toHaveLength(1);
    }
  });
  it("preserves conservative provider-managed storage failure behavior", async () => {
    const { root, input } = await setup("memory");
    const ledger = new EmailSubmissions(root);
    const writable = ledger as unknown as { persist(): void };
    const persist = writable.persist.bind(ledger);
    vi.spyOn(writable, "persist").mockImplementationOnce(persist).mockImplementation(() => { throw new Error("storage failed"); });
    await expect(ledger.send(input, async operationId => ({ operationId, accepted: ["recipient@example.com"], rejected: [], submittedAt: new Date().toISOString() })))
      .rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
    expect(ledger.list()[0].receipt).toBeUndefined();
    await expect(new EmailSubmissions(root).send(input, async () => { throw new Error("must not submit"); })).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
  });
  for (const faults of [{ rejectAuth: true }, { rejectAppend: true }, { stallAppend: true }, { dropAfterAppend: true }]) {
    it(`preserves SMTP success after ${JSON.stringify(faults)}`, async () => {
      const { adapter, input, smtp, imap, accounts } = await setup("local", faults);
      const receipt = await adapter.send(input);
      expect(receipt.accepted).toContain("recipient@example.com");
      expect(receipt.sentCopy?.state).toBe(faults.rejectAuth || faults.rejectAppend ? "failed" : "unknown");
      const restarted = new LocalEmailAdapter(accounts, { SECRET: "fixture-secret" }); cleanup.push(() => restarted.stop());
      expect(await restarted.send(input)).toEqual(receipt);
      expect(smtp.messages).toHaveLength(1);
      expect(imap.appendedMime.length).toBeLessThanOrEqual(1);
    });
  }
  it("does not append after uncertain SMTP acceptance or all recipient rejection", async () => {
    for (const faults of [{ dropAfterData: true }, { rejectRecipient: "recipient@example.com" }]) {
      const { adapter, input, imap } = await setup("local", {}, faults);
      await expect(adapter.send({ ...input, bcc: [] })).rejects.toBeDefined();
      expect(imap.appendedMime).toHaveLength(0);
    }
  });
  it("recovers a durable accepted receipt with pending copy without calling either provider", async () => {
    const { root, input } = await setup("memory");
    const ledger = new EmailSubmissions(root);
    let checkpoint!: () => void;
    const recorded = new Promise<void>(resolve => { checkpoint = resolve; });
    void ledger.send(input, async (operationId, accepted) => {
      accepted({ operationId, accepted: ["recipient@example.com"], rejected: [], submittedAt: new Date().toISOString(), sentCopy: { state: "pending" } });
      checkpoint();
      return new Promise(() => {});
    });
    await recorded;
    const receipt = await new EmailSubmissions(root).send(input, async () => { throw new Error("must not contact provider"); });
    expect(receipt.sentCopy).toEqual({ state: "unknown" });
    expect(receipt.warnings).toEqual(["EMAIL_SENT_COPY_OUTCOME_UNKNOWN"]);
  });
});
