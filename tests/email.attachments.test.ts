import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { EmailAccounts } from "../src/email/accounts.js";
import { saveSelectedAttachment } from "../src/email/attachments.js";
import { replyMessage, validateReply } from "../src/email/replies.js";
import { InMemoryEmailAdapter, LocalEmailAdapter } from "../src/email/adapter.js";
import { messageRef, type MailRecord } from "../src/email/messages.js";
import { stageEmail, releaseEmailHost } from "../src/email/host.js";
import { EmailSubmissions, validateSend } from "../src/email/submissions.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import { createCompletedOnlyStageHandle, type StageRunInput } from "../src/agent/port.js";
import { createDownloadEmailAttachmentTool } from "../src/tools/readEmail.js";
import { mailServer } from "./fixtures/mailServers.js";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const bytes = Buffer.from([0, 255, 13, 10, 42, 128]);
async function mime(content = bytes, filename = "../../bad\\report.bin"): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const result = await transport.sendMail({ from: "sender@example.com", to: "agent@example.com", subject: "Report", text: "Selected report", messageId: "<report@example.com>", attachments: [{ filename, content }] });
  return result.message as Buffer;
}
async function setup(kind: "memory" | "local") {
  const root = await mkdtemp(path.join(tmpdir(), "sf-attachments-")); roots.push(root);
  const record: MailRecord = { uid: 1, source: await mime(), receivedAt: new Date("2026-10-05T12:00:00Z"), flags: new Set() };
  const imap = await mailServer("imap", { mailboxMessages: [record] });
  const smtp = await mailServer("smtp");
  cleanups.push(() => imap.close(), () => smtp.close());
  const accounts = new EmailAccounts(root);
  function connection(port: number) { return { host: "127.0.0.1", port, username: "user", tls: "none" as const, auth: { type: "password" as const, secretRef: "env:MAIL_SECRET" } }; }
  const account = accounts.create({ displayName: "Agent", address: "agent@example.com", imap: connection(imap.port), smtp: connection(smtp.port), allowInsecureLocalDevelopment: true });
  const adapter = kind === "memory" ? new InMemoryEmailAdapter(accounts) : new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" });
  cleanups.push(() => adapter.stop());
  const context = { workspaceDir: path.join(root, "run-workspace"), stageId: "notify", attempt: 2 };
  const artifact = "stages/notify/attempts/2/artifacts/report.bin";
  await mkdir(path.dirname(path.join(context.workspaceDir, artifact)), { recursive: true });
  await writeFile(path.join(context.workspaceDir, artifact), bytes);
  function seed(source: Buffer) {
    record.source = source;
    imap.mailbox.messages = [record];
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, [record]);
  }
  seed(record.source);
  const ref = messageRef(account, "INBOX", "1", 1);
  const input = { accountId: account.accountId, operationKey: "report", to: [{ address: "recipient@example.com" }], subject: "Report", text: "Report attached", attachments: [{ artifact, filename: "../../report.bin" }] };
  const stage = { id: "notify", model: "model", system_prompt: "notify", email: [{ accountId: account.accountId, operations: ["send", "reply", "getMessage", "downloadAttachment"] as ("send" | "reply" | "getMessage" | "downloadAttachment")[] }] };
  return { root, accounts, account, adapter, imap, smtp, context, artifact, ref, input, stage, seed };
}
for (const kind of ["memory", "local"] as const) describe(`${kind} bounded email attachments`, () => {
  it("submits and retrieves identical MIME bytes, uses safe names, and retains no attachment archive", async () => {
    const { root, adapter, context, stage, input, smtp, ref, seed, imap } = await setup(kind);
    const email = stageEmail(adapter, stage, "run-1", context);
    const receipt = await email.send(input);
    expect(receipt.accepted).toEqual(["recipient@example.com"]);
    if (adapter instanceof InMemoryEmailAdapter) {
      expect(adapter.sentAttachments[0][0]).toEqual({ filename: "report.bin", content: bytes });
    } else {
      const parsed = await simpleParser(smtp.messages[0].data);
      expect(parsed.attachments[0].content).toEqual(bytes);
      expect(parsed.attachments[0].filename).toBe("report.bin");
      seed(Buffer.from(smtp.messages[0].data));
    }
    const downloaded = await email.downloadAttachment({ ref, attachmentId: "0" });
    expect(downloaded.size).toBe(bytes.length);
    expect(downloaded.artifact).toMatch(/^stages\/notify\/attempts\/2\/artifacts\/email-[a-f0-9-]+\.bin$/);
    expect(await readFile(path.join(context.workspaceDir, downloaded.artifact))).toEqual(bytes);
    expect(JSON.stringify(downloaded)).not.toContain(bytes.toString("base64"));
    expect((await adapter.getMessage(ref)).unread).toBe(true);
    expect(imap.mailbox.messages[0].flags.has("\\Seen")).toBe(false);
    expect((await readdir(path.join(root, ".stageflow"))).sort()).toEqual(["email-accounts.json", "email-submissions.json"]);
    const ledger = await readFile(path.join(root, ".stageflow", "email-submissions.json"), "utf8");
    expect(ledger).not.toContain("Report attached"); expect(ledger).not.toContain("report.bin");
  });
  it("reuses a key only for the same submitted bytes and supports reply attachments", async () => {
    const { adapter, context, input, artifact, ref, smtp } = await setup(kind);
    const first = await adapter.send(input, context);
    expect(await adapter.send(input, context)).toEqual(first);
    await writeFile(path.join(context.workspaceDir, artifact), Buffer.from("changed"));
    await expect(adapter.send(input, context)).rejects.toMatchObject({ code: "EMAIL_OPERATION_CONFLICT" });
    await adapter.reply({ ref, operationKey: "reply", text: "Reply attached", attachments: input.attachments }, context);
    if (adapter instanceof InMemoryEmailAdapter) expect(adapter.sentAttachments[1][0].content.toString()).toBe("changed");
    else { expect(smtp.messages).toHaveLength(2); expect((await simpleParser(smtp.messages[1].data)).attachments[0].content.toString()).toBe("changed"); }
  });
  it("keeps receipts from sends recorded before attachment support", async () => {
    const { root, adapter, input, account } = await setup(kind);
    const { attachments: _attachments, ...plain } = input;
    const validated = validateSend(plain, account);
    const receipt = { operationId: "old-operation", accepted: ["recipient@example.com"], rejected: [], submittedAt: new Date().toISOString() };
    await new EmailSubmissions(root).send(validated, async () => receipt);
    // The existing adapter loaded its ledger before this simulated previous host.
    const accounts = new EmailAccounts(root);
    const restarted = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
    cleanups.push(() => restarted.stop());
    expect(await restarted.send(plain)).toEqual(receipt);
    await adapter.stop();
  });
  it("keeps receipts from replies recorded before attachment support", async () => {
    const { root, adapter, account, ref, smtp } = await setup(kind);
    const reply = validateReply({ ref, operationKey: "old-reply", text: "Previous reply" });
    const original = await adapter.getMessage(ref);
    const message = validateSend(replyMessage(account, original, reply), account);
    const receipt = { operationId: "old-reply-operation", accepted: ["sender@example.com"], rejected: [], submittedAt: new Date().toISOString() };
    await new EmailSubmissions(root).send(message, async () => receipt, { operation: "reply", ref: original.ref, replyAll: false });
    const accounts = new EmailAccounts(root);
    const restarted = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
    cleanups.push(() => restarted.stop());
    if (restarted instanceof InMemoryEmailAdapter) {
      restarted.seedMailbox(account.accountId, [{ uid: 1, source: await mime(), receivedAt: new Date(), flags: new Set() }]);
    }
    expect(await restarted.reply(reply)).toEqual(receipt);
    expect(smtp.messages).toHaveLength(0);
  });
  it("rejects actual bytes above the limit when descriptor size is underreported", async () => {
    const { accounts, account, adapter, context, input, artifact, smtp } = await setup(kind);
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 5, totalBytes: 5, downloadBytes: 4096 } });
    const handle = await open(path.join(context.workspaceDir, artifact), "r");
    const prototype = Object.getPrototypeOf(handle);
    const stat = prototype.stat;
    await handle.close();
    const sizeFault = vi.spyOn(prototype, "stat").mockImplementation(async function (this: typeof handle) {
      const result = await stat.call(this);
      result.size = 1;
      return result;
    });
    try {
      await expect(adapter.send(input, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
      expect(sizeFault).toHaveBeenCalled();
      expect(smtp.commands).not.toContain("DATA");
      expect(adapter.submissions.list()).toEqual([]);
    } finally { sizeFault.mockRestore(); }
  });
  it("rejects traversal, credentials, unrelated files, symlinks and hard links before SMTP", async () => {
    const { root, adapter, context, input, artifact, smtp } = await setup(kind);
    const artifacts = path.dirname(path.join(context.workspaceDir, artifact));
    const secret = path.join(root, "auth.json"); await writeFile(secret, "secret");
    await symlink(secret, path.join(artifacts, "linked.bin"));
    await link(secret, path.join(artifacts, "hard.bin"));
    await symlink(root, path.join(artifacts, "linked-dir"));
    await mkdir(path.join(artifacts, ".pi-agent")); await writeFile(path.join(artifacts, ".pi-agent", "session"), "private");
    const prefix = "stages/notify/attempts/2/artifacts/";
    for (const candidate of ["../auth.json", "/etc/passwd", "log.jsonl", `${prefix}../pi-session.jsonl`, `${prefix}auth.json`, `${prefix}.pi-agent/session`, `${prefix}pi-session.jsonl`, `${prefix}linked.bin`, `${prefix}hard.bin`, `${prefix}linked-dir/auth.json`, `${prefix}missing.bin`, `${prefix}folder\\report.bin`]) {
      await expect(adapter.send({ ...input, attachments: [{ artifact: candidate }] }, context)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    }
    await expect(adapter.send(input)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    expect(smtp.commands).toEqual([]);
  });
  it("checks count, per-file and total bytes before SMTP DATA", async () => {
    const { accounts, account, adapter, context, input, smtp } = await setup(kind);
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 6, totalBytes: 6, downloadBytes: 4096 } });
    await expect(adapter.send({ ...input, attachments: [...input.attachments, ...input.attachments] }, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    accounts.update(account.accountId, { attachmentLimits: { count: 2, perFileBytes: 5, totalBytes: 12, downloadBytes: 4096 } });
    await expect(adapter.send(input, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    accounts.update(account.accountId, { attachmentLimits: { count: 2, perFileBytes: 6, totalBytes: 11, downloadBytes: 4096 } });
    await expect(adapter.send({ ...input, attachments: [...input.attachments, ...input.attachments] }, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    expect(smtp.commands).not.toContain("DATA");
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 6, totalBytes: 6, downloadBytes: 4096 } });
    expect((await adapter.send(input, context)).accepted).toHaveLength(1);
  });
  it("requires explicit download permission and returns only authorized artifact metadata", async () => {
    const { adapter, context, stage, ref } = await setup(kind);
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0" })).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    const readOnly = { ...stage, email: [{ accountId: ref.accountId, operations: ["getMessage" as const] }] };
    await expect(stageEmail(adapter, readOnly, "run-1", context).downloadAttachment({ ref, attachmentId: "0" })).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    const tool = createDownloadEmailAttachmentTool(stageEmail(adapter, stage, "run-1", context));
    const result = await tool.execute("download", { ref, attachmentId: "0" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ filename: "report.bin", size: 6 });
    expect(result.content[0].text).not.toContain('"content"');
    await expect(adapter.downloadAttachment({ ref, attachmentId: "99" }, context)).rejects.toMatchObject({ code: "EMAIL_MESSAGE_NOT_FOUND" });
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0", workspaceDir: "/tmp" } as never, context)).rejects.toMatchObject({ code: "EMAIL_INVALID_INPUT" });
  });
  it("bounds incoming MIME source and decoded bytes without leaving failed files", async () => {
    const { accounts, account, adapter, context, artifact, ref, seed, imap } = await setup(kind);
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 5, totalBytes: 5, downloadBytes: 4096 } });
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0" }, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 6, totalBytes: 6, downloadBytes: 10 } });
    imap.fetchedSourceBytes.length = 0;
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0" }, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    if (kind === "local") expect(imap.fetchedSourceBytes).toEqual([]);
    accounts.update(account.accountId, { attachmentLimits: { count: 1, perFileBytes: 6, totalBytes: 6, downloadBytes: 4096 } });
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const multiple = await transport.sendMail({ from: "sender@example.com", text: "two", attachments: [{ filename: "one", content: bytes }, { filename: "two", content: bytes }] });
    seed(multiple.message as Buffer);
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0" }, context)).rejects.toMatchObject({ code: "EMAIL_RESOURCE_LIMIT" });
    expect(await readdir(path.dirname(path.join(context.workspaceDir, artifact)))).toEqual(["report.bin"]);
  });
  it("rejects a symlinked output directory and normalizes malicious display names", async () => {
    const { root, adapter, context, ref, seed } = await setup(kind);
    seed(await mime(bytes, "../../auth.json\r\nInjected"));
    const message = await adapter.getMessage(ref);
    expect(message.attachments[0].filename).not.toMatch(/[/\\\r\n]/);
    const outputContext = { ...context, stageId: "receive" };
    const stageDir = path.join(context.workspaceDir, "stages", "receive");
    await symlink(root, stageDir);
    await expect(adapter.downloadAttachment({ ref, attachmentId: "0" }, outputContext)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    expect((await readdir(root)).some(name => name.startsWith("email-"))).toBe(false);
  });
});

describe("incoming attachment account changes", () => {
  for (const disabledAt of [1, 3]) {
    it(`rejects account disable ${disabledAt === 1 ? "after parsing" : "after writing"} and removes any output`, async () => {
      const { accounts, account, context, artifact } = await setup("memory");
      const source = await mime();
      let validations = 0;
      await expect(saveSelectedAttachment(account, source, "0", context, () => {
        validations++;
        if (validations === disabledAt) {
          const outputs = readdirSync(path.dirname(path.join(context.workspaceDir, artifact))).filter(name => name.startsWith("email-"));
          expect(outputs).toHaveLength(disabledAt === 1 ? 0 : 1);
          accounts.update(account.accountId, { enabled: false });
        }
        accounts.get(account.accountId);
      })).rejects.toMatchObject({ code: "EMAIL_ACCOUNT_DISABLED" });
      expect(validations).toBe(disabledAt);
      expect(await readdir(path.dirname(path.join(context.workspaceDir, artifact)))).toEqual(["report.bin"]);
    });
  }
});

describe("attachment worker IPC", () => {
  it("sends a report and downloads selected bytes through in-process stage execution", async () => {
    const { root, account, stage, input, ref, smtp } = await setup("local");
    const previous = process.env.MAIL_SECRET;
    process.env.MAIL_SECRET = "fixture-secret";
    cleanups.push(() => releaseEmailHost(root));
    try {
      await mkdir(path.join(root, "pipelines"));
      await mkdir(path.join(root, "stages"));
      await writeFile(path.join(root, "pipelines", "notify.pipeline.yaml"), "id: notify\nstages:\n  - id: notify\n    uses: ../stages/notify.yaml\n    entry: true\n");
      await writeFile(path.join(root, "stages", "notify.yaml"), `id: notify\nmodel: model\nsystem_prompt: notify\nemail:\n  - accountId: ${account.accountId}\n    operations: [send, downloadAttachment]\nio:\n  input:\n    schema: { type: object }\n  output:\n    schema: { type: object }\n`);
      const loaded = await loadPipeline("pipelines/notify.pipeline.yaml", { cwd: root });
      const store = createRunStore({ rootDir: root });
      const run = await store.createRun({ pipelineId: "notify", taskYaml: "id: report\ngoal: Share report\n" });
      const artifact = "stages/notify/attempts/1/artifacts/report.bin";
      await mkdir(path.dirname(path.join(run.workspaceDir, artifact)), { recursive: true });
      await writeFile(path.join(run.workspaceDir, artifact), bytes);
      const agent = { openStage(value: StageRunInput) {
        return createCompletedOnlyStageHandle({ stageId: stage.id, run: async () => {
          await value.email!.send({ ...input, attachments: [{ artifact }] });
          const result = await value.email!.downloadAttachment({ ref, attachmentId: "0" });
          expect(result.artifact).toMatch(/^stages\/notify\/attempts\/1\/artifacts\/email-/);
          expect(await readFile(path.join(run.workspaceDir, result.artifact))).toEqual(bytes);
          return { ok: true, envelope: { status: "success", summary: "Shared report", artifacts: [] } };
        } });
      } };
      const opened = await openStageAttempt({ agent, store, runId: run.runId, stage: loaded.stages[0], dag: loaded.dag,
        task: { id: "report", goal: "Share report" }, workspaceDir: run.workspaceDir, factoryCwd: root });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        try { expect(await opened.handle.next()).toMatchObject({ status: "completed", result: { ok: true } }); }
        finally { await opened.handle.close(); }
      }
      expect(smtp.messages).toHaveLength(1);
      expect((await simpleParser(smtp.messages[0].data)).attachments[0].content).toEqual(bytes);
    } finally {
      if (previous === undefined) delete process.env.MAIL_SECRET;
      else process.env.MAIL_SECRET = previous;
    }
  });
  it("uses host workspace and attempt, rejects forged authority, and downloads selected bytes", async () => {
    const { root, account, context, stage, input, ref, smtp } = await setup("local");
    const previous = process.env.MAIL_SECRET; process.env.MAIL_SECRET = "fixture-secret";
    cleanups.push(() => releaseEmailHost(root));
    try {
      const launcher = new StageProcessLauncher({ cliEntry: fileURLToPath(new URL("./fixtures/emailAttachmentWorker.mjs", import.meta.url)), env: { EMAIL_TEST_INPUT: JSON.stringify(input), EMAIL_TEST_REF: JSON.stringify(ref) } });
      expect(await launcher.launch({ rootDir: root, workspaceDir: context.workspaceDir, attempt: 2, stageId: stage.id, runId: "trusted-run", stage })).toEqual({ type: "succeeded" });
      expect(smtp.messages).toHaveLength(1);
      const artifacts = await readdir(path.join(context.workspaceDir, "stages", "notify", "attempts", "2", "artifacts"));
      const downloaded = artifacts.find(name => name.startsWith("email-"))!;
      expect(await readFile(path.join(context.workspaceDir, "stages", "notify", "attempts", "2", "artifacts", downloaded))).toEqual(bytes);
      expect(account.accountId).toBe(ref.accountId);
    } finally { if (previous === undefined) delete process.env.MAIL_SECRET; else process.env.MAIL_SECRET = previous; }
  });
});
