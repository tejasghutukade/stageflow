import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailAccounts } from "../src/email/accounts.js";
import { InMemoryEmailAdapter, LocalEmailAdapter } from "../src/email/adapter.js";
import { EMAIL_SOURCE_LIMIT, messageRef, type MailRecord } from "../src/email/messages.js";
import { stageEmail, releaseEmailHost } from "../src/email/host.js";
import { createSearchEmailTool, createGetEmailTool } from "../src/tools/readEmail.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createCompletedOnlyStageHandle, type StageRunInput } from "../src/agent/port.js";
import { mailServer } from "./fixtures/mailServers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function record(uid: number, body = "A provider message.", headers = ""): MailRecord {
  return { uid, source: Buffer.from(`From: sender@example.com\r\nTo: agent@example.com\r\nSubject: Message ${uid}\r\nMessage-ID: <message-${uid}@example.com>\r\n${headers}\r\n${body}`), flags: new Set(uid === 1 ? ["\\Seen", "\\Flagged"] : []), receivedAt: new Date("2026-01-01T12:00:00Z") };
}
async function setup(kind: "memory" | "local", records = [record(1), record(2)]) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-email-read-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = await mailServer("imap", { mailboxMessages: records }); cleanups.push(() => server.close());
  const accounts = new EmailAccounts(root);
  const connection = { host: "127.0.0.1", port: server.port, username: "user", tls: "none" as const, auth: { type: "password" as const, secretRef: "env:MAIL_SECRET" } };
  const account = accounts.create({ displayName: "Mailbox", address: "agent@example.com", imap: connection, smtp: connection, allowInsecureLocalDevelopment: true, connectionTimeoutMs: 2000 });
  const adapter = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
  if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, records);
  cleanups.push(() => adapter.stop());
  return { root, server, accounts, account, adapter };
}
for (const kind of ["memory", "local"] as const) describe(`${kind} message contract`, () => {
  it("selects recent summaries and reads the same provider message without changing flags", async () => {
    const { adapter, account, server, root } = await setup(kind);
    const listed = await adapter.search({ accountId: account.accountId });
    expect(listed.messages.map(value => value.subject)).toEqual(["Message 2", "Message 1"]);
    expect(listed.messages[0]).toMatchObject({ from: [{ address: "sender@example.com" }], to: [{ address: "agent@example.com" }], unread: true, flagged: false });
    expect(listed.messages[1]).toMatchObject({ unread: false, flagged: true });
    expect(listed.messages[0]).not.toHaveProperty("text"); expect(listed.messages[0]).not.toHaveProperty("threadId");
    const message = await adapter.getMessage(listed.messages[0].ref);
    expect(message.text.trim()).toBe("A provider message.");
    expect((await adapter.search({ accountId: account.accountId })).messages[0].unread).toBe(true);
    expect(server.mailbox.messages[1].flags.has("\\Seen")).toBe(false);
    // A second client can retrieve the same unchanged provider message.
    if (kind === "local") {
      const second = new LocalEmailAdapter(new EmailAccounts(root), { MAIL_SECRET: "fixture-secret" }); cleanups.push(() => second.stop());
      expect((await second.getMessage(message.ref)).text).toBe(message.text);
      expect(server.commands).not.toContain("STORE"); expect(server.commands).not.toContain("SELECT");
    }
    const saved = await Promise.all((await readdir(path.join(root, ".stageflow"))).map(file => readFile(path.join(root, ".stageflow", file), "utf8")));
    expect(saved.join("")).not.toContain(message.text.trim());
  });
  it("bounds recent lists and rejects optional filters and bad inputs", async () => {
    const { adapter, account } = await setup(kind, Array.from({ length: 105 }, (_, index) => record(index + 1)));
    expect((await adapter.search({ accountId: account.accountId })).messages).toHaveLength(20);
    expect((await adapter.search({ accountId: account.accountId, limit: 100 })).messages).toHaveLength(100);
    for (const patch of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { mailbox: "\r\n" }, { mailbox: "Missing" }]) await expect(adapter.search({ accountId: account.accountId, ...patch })).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    await expect(adapter.search({ accountId: account.accountId, cursor: "opaque" })).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    for (const patch of [{ hasAttachments: false }, { text: "test" }]) await expect(adapter.search({ accountId: account.accountId, ...patch })).rejects.toMatchObject({ code: "EMAIL_SEARCH_UNSUPPORTED", unsupportedFields: Object.keys(patch) });
  });
  it("rejects invalid, missing, stale, and cross-account references", async () => {
    const { adapter, account, accounts, server } = await setup(kind);
    await expect(adapter.getMessage({ accountId: account.accountId, id: "invalid" })).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    await expect(adapter.getMessage(messageRef(account, "INBOX", "1", 99))).rejects.toMatchObject({ code: "EMAIL_MESSAGE_NOT_FOUND" });
    const ref = (await adapter.search({ accountId: account.accountId })).messages[0].ref;
    const { accountId: _id, scope: _scope, ...config } = account;
    const other = accounts.create(config);
    await expect(adapter.getMessage({ ...ref, accountId: other.accountId })).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    server.mailbox.generation = "2";
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages, "INBOX", "2");
    await expect(adapter.getMessage(ref)).rejects.toMatchObject({ code: "EMAIL_STALE_REFERENCE" });
    accounts.update(account.accountId, { enabled: false });
    await expect(adapter.getMessage(ref)).rejects.toMatchObject({ code: "EMAIL_ACCOUNT_DISABLED" });
  });
  it("combines exact addresses, subject, false flags, and UTC date edges", async () => {
    const records = [record(1), record(2), record(3), record(4), record(5)];
    records[0].receivedAt = new Date("2026-01-01T11:59:59Z");
    records[1].receivedAt = new Date("2026-01-01T12:00:00Z");
    records[2].receivedAt = new Date("2026-01-01T12:59:59Z");
    records[3].receivedAt = new Date("2026-01-01T13:00:00Z");
    records[4].receivedAt = new Date("2026-01-01T12:30:00Z");
    records[4].source = Buffer.from(records[4].source.toString().replace("sender@example.com", "other-sender@example.com"));
    const { adapter, account } = await setup(kind, records);
    const query = { accountId: account.accountId, from: "SENDER@EXAMPLE.COM", to: "AGENT@EXAMPLE.COM", subject: "MESSAGE", unread: true, flagged: false,
      receivedAfter: "2026-01-01T07:00:00-05:00", receivedBefore: "2026-01-01T13:00:00Z" };
    expect((await adapter.search(query)).messages.map(value => value.subject)).toEqual(["Message 3", "Message 2"]);
    expect((await adapter.search({ accountId: account.accountId, unread: false })).messages.map(value => value.subject)).toEqual(["Message 1"]);
    expect((await adapter.search({ accountId: account.accountId, flagged: true })).messages.map(value => value.subject)).toEqual(["Message 1"]);
    expect((await adapter.search({ accountId: account.accountId, from: "sender" })).messages).toEqual([]);
    expect((await adapter.search({ accountId: account.accountId, to: "agent" })).messages).toEqual([]);
    expect((await adapter.search({ ...query, sort: "oldest" })).messages.map(value => value.subject)).toEqual(["Message 2", "Message 3"]);
    expect((await adapter.testAccount(account.accountId, "imap")).capabilities.searchFields).toEqual(["from", "to", "subject", "unread", "flagged", "receivedAfter", "receivedBefore"]);
    for (const patch of [{ receivedAfter: "2026-02-31T12:00:00Z" }, { receivedAfter: "2026-01-01" }, { receivedAfter: "2026-01-01T12:00:00" }, { receivedAfter: "bad" }, { receivedAfter: "2026-01-01T13:00:00Z", receivedBefore: "2026-01-01T12:00:00Z" }, { unread: "false" }, { from: 4 }]) {
      await expect(adapter.search({ accountId: account.accountId, ...patch } as never)).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    }
  });
  for (const sort of ["newest", "oldest"] as const) it(`keeps ${sort} pages stable with UID gaps, new mail, and removed messages`, async () => {
    const records = [record(2), record(100000), record(200000), record(300000)];
    const { adapter, account, server } = await setup(kind, records);
    const query = { accountId: account.accountId, limit: 1, sort };
    const first = await adapter.search(query);
    expect(first.nextCursor).toBeTypeOf("string");
    const removed = sort === "newest" ? 200000 : 100000;
    server.mailbox.messages = records.filter(value => value.uid !== removed).concat(record(900000));
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages);
    const subjects = first.messages.map(value => value.subject);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await adapter.search({ ...query, cursor });
      subjects.push(...next.messages.map(value => value.subject));
      cursor = next.nextCursor;
    }
    expect(subjects).toEqual(sort === "newest" ? ["Message 300000", "Message 100000", "Message 2"] : ["Message 2", "Message 200000", "Message 300000"]);
    expect(server.fetchedSourceBytes).toEqual([]);
  });
  it("rejects changed, altered, foreign, and stale cursors", async () => {
    const { adapter, account, accounts, server } = await setup(kind, [record(1), record(2), record(3)]);
    const query = { accountId: account.accountId, limit: 1 };
    const cursor = (await adapter.search(query)).nextCursor!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const changedEncoding = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1)!) + 1];
    const { accountId: _id, scope: _scope, ...config } = account;
    const other = accounts.create(config);
    for (const patch of [{ cursor: `${cursor.slice(0, -1)}!` }, { cursor: changedEncoding }, { cursor: cursor.replace(/^./, cursor[0] === "A" ? "B" : "A") }, { subject: "Message" }, { sort: "oldest" as const }, { limit: 2 }, { mailbox: "Missing" }, { accountId: other.accountId }]) {
      await expect(adapter.search({ ...query, cursor, ...patch })).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    }
    const replacement = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
    cleanups.push(() => replacement.stop());
    if (replacement instanceof InMemoryEmailAdapter) replacement.seedMailbox(account.accountId, server.mailbox.messages);
    await expect(replacement.search({ ...query, cursor })).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
    server.mailbox.generation = "2";
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages, "INBOX", "2");
    await expect(adapter.search({ ...query, cursor })).rejects.toMatchObject({ code: "EMAIL_STALE_REFERENCE" });
  });
  it("reports a work limit without partial success and resumes beyond prior pages", async () => {
    const { adapter, account, accounts, server } = await setup(kind, Array.from({ length: 8 }, (_, index) => record(index + 1)));
    accounts.update(account.accountId, { searchWorkLimit: 2 });
    await expect(adapter.search({ accountId: account.accountId, subject: "absent" })).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    await expect(adapter.search({ accountId: account.accountId, limit: 2 })).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    const subjects = [];
    let cursor: string | undefined;
    do {
      const result = await adapter.search({ accountId: account.accountId, limit: 1, cursor });
      subjects.push(...result.messages.map(value => value.subject));
      cursor = result.nextCursor;
    } while (cursor);
    expect(subjects).toEqual(Array.from({ length: 8 }, (_, index) => `Message ${8 - index}`));
    accounts.update(account.accountId, { searchWorkLimit: 10 });
    expect((await adapter.search({ accountId: account.accountId, subject: "absent" })).messages).toEqual([]);
    expect(server.fetchedSourceBytes).toEqual([]);
    expect((await adapter.search({ accountId: account.accountId })).messages.filter(value => !value.unread)).toHaveLength(1);
  });
  it("parses MIME reply headers and attachment metadata without attachment bytes", async () => {
    const source = record(1, "--edge\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody text\r\n--edge\r\nContent-Type: text/html\r\n\r\n<p>Body text</p>\r\n--edge\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=data.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n--edge--\r\n", "Reply-To: reply@example.com\r\nReferences: <one@example.com> <two@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=edge\r\n");
    const { adapter, account } = await setup(kind, [source]);
    const ref = (await adapter.search({ accountId: account.accountId })).messages[0].ref;
    const message = await adapter.getMessage(ref);
    expect(message.replyTo).toEqual([{ address: "reply@example.com" }]); expect(message.references).toEqual(["<one@example.com>", "<two@example.com>"]);
    expect(message.text).toContain("Body text"); expect(message.html).toContain("<p>Body text</p>");
    expect(message.attachments).toEqual([{ id: "0", filename: "data.bin", contentType: "application/octet-stream", size: 3 }]);
    expect(JSON.stringify(message)).not.toContain("YWJj");
  });
  it("lists large messages but enforces source and decoded body limits for retrieval", async () => {
    const { adapter, account, server } = await setup(kind, [record(1, "x".repeat(EMAIL_SOURCE_LIMIT + 1)), record(2, "x".repeat(128 * 1024 + 1))]);
    const list = await adapter.search({ accountId: account.accountId }); expect(list.messages).toHaveLength(2);
    expect(server.fetchedSourceBytes).toEqual([]);
    for (const summary of list.messages) await expect(adapter.getMessage(summary.ref)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    expect(server.fetchedSourceBytes.every(value => value <= EMAIL_SOURCE_LIMIT + 1)).toBe(true);
  });
  it("handles malformed MIME and missing optional headers as data", async () => {
    const raw = { ...record(1), source: Buffer.from("Content-Type: text/plain; charset=unknown-charset\r\n\r\nMalformed \xff text", "binary") };
    const { adapter, account } = await setup(kind, [raw]);
    const message = await adapter.getMessage((await adapter.search({ accountId: account.accountId })).messages[0].ref);
    expect(message.from).toEqual([]); expect(message.to).toEqual([]); expect(message.subject).toBeUndefined(); expect(message.messageId).toBeUndefined(); expect(message.text).toContain("Malformed");
  });
  it("enforces frozen stage permissions through the read tools", async () => {
    const { adapter, account } = await setup(kind, [record(1), record(2), record(3)]);
    const stage = { id: "read", model: "test", system_prompt: "read", email: [{ accountId: account.accountId, operations: ["search", "getMessage"] as ("search" | "getMessage")[] }] };
    const email = stageEmail(adapter, stage, "run"); stage.email[0].operations = [];
    const query = { accountId: account.accountId, unread: true, from: "sender@example.com", limit: 1 };
    const search = await createSearchEmailTool(email).execute("list", query);
    expect(search.isError).toBeUndefined();
    const page = search.details as { messages: { ref: unknown }[]; nextCursor: string };
    expect(page.nextCursor).toBeTypeOf("string");
    const second = await createSearchEmailTool(email).execute("next", { ...query, cursor: page.nextCursor });
    const ref = (second.details as { messages: { ref: unknown }[] }).messages[0].ref;
    expect((await createGetEmailTool(email).execute("get", ref)).isError).toBeUndefined();
    expect(await createSearchEmailTool(email).execute("other", { accountId: "other" })).toMatchObject({ isError: true, details: { code: "EMAIL_UNAUTHORIZED" } });
    expect(await createSearchEmailTool(email).execute("unsupported", { accountId: account.accountId, text: "body", hasAttachments: false })).toMatchObject({ isError: true, details: { code: "EMAIL_SEARCH_UNSUPPORTED", unsupportedFields: ["text", "hasAttachments"] } });
    await expect(stageEmail(adapter, stage, "run").getMessage(ref as never)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
  });
});
it("lists and reads through the actual private child IPC and rejects undeclared operations", async () => {
  const { root, account } = await setup("local", [record(1), record(2), record(3)]);
  cleanups.push(() => releaseEmailHost(root));
  const previous = process.env.MAIL_SECRET; process.env.MAIL_SECRET = "fixture-secret";
  const stage = { id: "read", model: "test", system_prompt: "read", email: [{ accountId: account.accountId, operations: ["search", "getMessage"] as ("search" | "getMessage")[] }] };
  try {
    for (const denied of [false, true]) {
      const launcher = new StageProcessLauncher({ cliEntry: fileURLToPath(new URL("./fixtures/emailReadWorker.mjs", import.meta.url)), env: { EMAIL_ACCOUNT: account.accountId, EMAIL_EXPECT_DENIED: String(denied) } });
      expect(await launcher.launch({ rootDir: root, stageId: "read", runId: "run", stage: denied ? { ...stage, email: [] } : stage })).toEqual({ type: "succeeded" });
    }
  } finally { if (previous === undefined) delete process.env.MAIL_SECRET; else process.env.MAIL_SECRET = previous; }
});
it("rejects unknown and disabled declared accounts before starting a child", async () => {
  const { root, account, accounts } = await setup("local");
  cleanups.push(() => releaseEmailHost(root));
  const launcher = new StageProcessLauncher({ cliEntry: fileURLToPath(new URL("./fixtures/emailReadWorker.mjs", import.meta.url)) });
  for (const id of ["unknown", account.accountId]) {
    if (id === account.accountId) accounts.update(id, { enabled: false });
    const stage = { id: "read", model: "test", system_prompt: "read", email: [{ accountId: id, operations: ["search" as const] }] };
    // Release cached configuration so the host reads the changed account state.
    await releaseEmailHost(root);
    expect(await launcher.launch({ rootDir: root, stageId: "read", runId: "run", stage })).toEqual({ type: "failed", reason: id === "unknown" ? "EMAIL_ACCOUNT_NOT_FOUND" : "EMAIL_ACCOUNT_DISABLED" });
    expect(launcher.activeCount()).toBe(0);
  }
});
it("reads through in-process stage execution and rejects bad account declarations before agent execution", async () => {
  const { root, account, accounts } = await setup("local");
  cleanups.push(() => releaseEmailHost(root));
  const previous = process.env.MAIL_SECRET; process.env.MAIL_SECRET = "fixture-secret";
  await mkdir(path.join(root, "pipelines")); await mkdir(path.join(root, "stages"));
  await writeFile(path.join(root, "pipelines", "read.yaml"), "id: read\nstages: [read]\n");
  await writeFile(path.join(root, "stages", "read.yaml"), `id: read\nmodel: test\nsystem_prompt: Read\nemail:\n  - accountId: ${account.accountId}\n    operations: [search, getMessage]\n`);
  const loaded = await loadPipeline("read", { cwd: root });
  const store = createRunStore({ rootDir: root });
  const run = await store.createRun({ pipelineId: "read", taskYaml: "id: read\ngoal: Read\n" });
  let openedCount = 0;
  const agent = { openStage(input: StageRunInput) {
    openedCount++;
    return createCompletedOnlyStageHandle({ stageId: "read", run: async () => {
      const list = await input.email!.search({ accountId: account.accountId });
      const message = await input.email!.getMessage(list.messages[0].ref);
      expect(message.text).toContain("A provider message."); expect(message.unread).toBe(true);
      return { ok: true, envelope: { status: "success", summary: "read", artifacts: [] } };
    } });
  } };
  try {
    const input = { agent, store, runId: run.runId, stage: loaded.stages[0], dag: loaded.dag, task: { id: "read", goal: "Read" }, workspaceDir: run.workspaceDir, factoryCwd: root };
    const opened = await openStageAttempt(input);
    expect(opened.ok).toBe(true);
    if (opened.ok) { expect(await opened.handle.next()).toMatchObject({ status: "completed", result: { ok: true } }); await opened.handle.close(); }
    expect(openedCount).toBe(1);
    expect(await openStageAttempt({ ...input, stage: { ...input.stage, email: [{ accountId: "unknown", operations: ["search"] }] } })).toMatchObject({ ok: false, reason: "EMAIL_ACCOUNT_NOT_FOUND" });
    await releaseEmailHost(root); accounts.update(account.accountId, { enabled: false });
    expect(await openStageAttempt(input)).toMatchObject({ ok: false, reason: "EMAIL_ACCOUNT_DISABLED" });
    expect(openedCount).toBe(1);
  } finally { if (previous === undefined) delete process.env.MAIL_SECRET; else process.env.MAIL_SECRET = previous; }
});
