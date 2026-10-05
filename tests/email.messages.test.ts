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
    for (const patch of [{ unread: false }, { from: "sender@example.com" }, { cursor: "opaque" }, { sort: "oldest" as const }, { hasAttachments: false }, { text: "test" }]) await expect(adapter.search({ accountId: account.accountId, ...patch })).rejects.toMatchObject({ code: "EMAIL_SEARCH_UNSUPPORTED" });
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
    const { adapter, account } = await setup(kind);
    const stage = { id: "read", model: "test", system_prompt: "read", email: [{ accountId: account.accountId, operations: ["search", "getMessage"] as ("search" | "getMessage")[] }] };
    const email = stageEmail(adapter, stage, "run"); stage.email[0].operations = [];
    const search = await createSearchEmailTool(email).execute("list", { accountId: account.accountId });
    expect(search.isError).toBeUndefined();
    const ref = (search.details as { messages: { ref: unknown }[] }).messages[0].ref;
    expect((await createGetEmailTool(email).execute("get", ref)).isError).toBeUndefined();
    expect(await createSearchEmailTool(email).execute("other", { accountId: "other" })).toMatchObject({ isError: true, details: { code: "EMAIL_UNAUTHORIZED" } });
    await expect(stageEmail(adapter, stage, "run").getMessage(ref as never)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
  });
});
it("lists and reads through the actual private child IPC and rejects undeclared operations", async () => {
  const { root, account } = await setup("local");
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
