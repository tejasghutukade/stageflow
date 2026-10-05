import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmailAccounts } from "../src/email/accounts.js";
import { LocalEmailAdapter, InMemoryEmailAdapter } from "../src/email/adapter.js";
import { EmailSubmissions } from "../src/email/submissions.js";
import { stageEmail, emailWorkerEnvironment, emailHostFor, releaseEmailHost, workerStageEmail } from "../src/email/host.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createCompletedOnlyStageHandle, type StageRunInput } from "../src/agent/port.js";
import { createSendEmailTool } from "../src/tools/sendEmail.js";
import { loadStage } from "../src/config/loadStage.js";
import { mailServer } from "./fixtures/mailServers.js";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(kind: "local" | "memory", options: Parameters<typeof mailServer>[1] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-send-")); roots.push(root);
  const server = await mailServer("smtp", options); cleanups.push(() => server.close());
  const accounts = new EmailAccounts(root);
  const connection = { host: "127.0.0.1", port: server.port, username: "user", tls: "none" as const, auth: { type: "password" as const, secretRef: "env:MAIL_SECRET" } };
  const account = accounts.create({ displayName: "Agent", address: "agent@example.com", senderAliases: ["alias@example.com"],
    imap: connection, smtp: connection, allowInsecureLocalDevelopment: true, connectionTimeoutMs: 500 });
  const adapter = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
  cleanups.push(() => adapter.stop());
  const input = { accountId: account.accountId, operationKey: "notice", to: [{ address: "recipient@example.com" }], subject: "Pipeline notice", text: "The work is done." };
  return { root, server, accounts, account, adapter, input };
}
for (const kind of ["local", "memory"] as const) describe(`${kind} send contract`, () => {
  it("submits once for concurrent repeats and recovers the receipt after restart", async () => {
    const { root, accounts, adapter, input, server } = await setup(kind);
    const [first, second] = await Promise.all([adapter.send(input), adapter.send(input)]);
    expect(first).toEqual(second); expect(first.accepted).toEqual(["recipient@example.com"]);
    const restarted = kind === "local" ? new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }) : new InMemoryEmailAdapter(accounts);
    cleanups.push(() => restarted.stop());
    expect(await restarted.send(input)).toEqual(first);
    await expect(adapter.send({ ...input, text: "Changed" })).rejects.toMatchObject({ code: "EMAIL_OPERATION_CONFLICT" });
    if (kind === "local") { expect(server.messages).toHaveLength(1); expect(server.messages[0].data).toContain("The work is done."); }
    const saved = await readFile(path.join(root, ".stageflow", "email-submissions.json"), "utf8");
    expect(saved).not.toContain(input.text); expect(saved).not.toContain("fixture-secret");
  });
  it("validates addresses, sender aliases, recipient counts and attachment references", async () => {
    const { adapter, input } = await setup(kind);
    for (const patch of [{ to: [] }, { from: "stranger@example.com" }, { subject: "header\r\ninjection" }, { attachments: [{ artifact: "secret" }] }]) {
      await expect(adapter.send({ ...input, ...patch })).rejects.toBeDefined();
    }
    expect((await adapter.send({ ...input, from: "alias@example.com", cc: [{ address: "cc@example.com" }], bcc: [{ address: "hidden@example.com" }] })).accepted).toHaveLength(3);
  });
  it("scopes tools to the host stage and strips mailbox secrets while preserving model credentials", async () => {
    const { accounts, adapter, input } = await setup(kind);
    const stage = { id: "notify", system_prompt: "Notify", model: "model", email: [{ accountId: input.accountId, operations: ["send" as const] }] };
    const scoped = stageEmail(adapter, stage, "run-1");
    stage.email[0].accountId = "forged";
    const tool = createSendEmailTool(scoped);
    expect((await tool.execute("call", input)).isError).toBeUndefined();
    expect((await tool.execute("call", { ...input, accountId: "forged" })).isError).toBe(true);
    await expect(stageEmail(adapter, { ...stage, email: [] }, "run-2").send(input)).rejects.toMatchObject({ code: "EMAIL_UNAUTHORIZED" });
    expect(emailWorkerEnvironment({ MAIL_SECRET: "secret", OPENAI_API_KEY: "model-secret" }, accounts)).toEqual({ OPENAI_API_KEY: "model-secret" });
  });
});
describe("SMTP outcomes and stage configuration", () => {
  it("cleans worker request listeners when the host disconnects", async () => {
    const { input } = await setup("memory");
    const previous = Object.getOwnPropertyDescriptor(process, "connected");
    Object.defineProperty(process, "connected", { value: true, configurable: true });
    const originalSend = process.send;
    process.send = vi.fn(() => true) as typeof process.send;
    const listeners = process.listenerCount("message");
    try {
      const pending = workerStageEmail().send(input);
      const outcome = expect(pending).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
      process.emit("disconnect");
      await outcome;
      expect(process.listenerCount("message")).toBe(listeners);
    } finally {
      process.send = originalSend;
      if (previous) Object.defineProperty(process, "connected", previous); else delete (process as { connected?: boolean }).connected;
    }
  });
  it("revalidates account configuration before a queued SMTP submission", async () => {
    const { accounts, adapter, input, server } = await setup("local");
    const pending = adapter.send(input);
    const outcome = expect(pending).rejects.toMatchObject({ code: "EMAIL_ACCOUNT_DISABLED" });
    accounts.update(input.accountId, { enabled: false });
    await outcome; expect(server.commands).toEqual([]);
  });
  it("uses private child IPC with frozen host permissions and no mailbox credentials", async () => {
    const { root, accounts, account, input, server } = await setup("local");
    const host = emailHostFor(root);
    cleanups.push(() => releaseEmailHost(root));
    const previous = process.env.MAIL_SECRET;
    process.env.MAIL_SECRET = "fixture-secret";
    const stage = { id: "notify", model: "model", system_prompt: "notify", email: [{ accountId: account.accountId, operations: ["send" as const] }] };
    try {
      const launcher = new StageProcessLauncher({ cliEntry: fileURLToPath(new URL("./fixtures/emailStageWorker.mjs", import.meta.url)),
        env: { EMAIL_TEST_INPUT: JSON.stringify(input), MODEL_TEST_SECRET: "preserved" } });
      expect(await launcher.launch({ rootDir: root, stageId: "notify", runId: "run-1", stage })).toEqual({ type: "succeeded" });
      expect(server.messages).toHaveLength(1);
      const unauthorized = new StageProcessLauncher({ cliEntry: fileURLToPath(new URL("./fixtures/emailStageWorker.mjs", import.meta.url)),
        env: { EMAIL_TEST_INPUT: JSON.stringify({ ...input, accountId: "forged-account" }), MODEL_TEST_SECRET: "preserved", EMAIL_EXPECT_ERROR: "EMAIL_UNAUTHORIZED" } });
      expect(await unauthorized.launch({ rootDir: root, stageId: "notify", runId: "run-2", stage })).toEqual({ type: "succeeded" });
      expect(server.messages).toHaveLength(1);
      expect(host.accounts.get(account.accountId).accountId).toBe(accounts.get(account.accountId).accountId);
    } finally { if (previous === undefined) delete process.env.MAIL_SECRET; else process.env.MAIL_SECRET = previous; }
  });
  it("provides scoped email through the existing in-process stage bootstrap", async () => {
    const { root, account, input, server } = await setup("local");
    const previous = process.env.MAIL_SECRET; process.env.MAIL_SECRET = "fixture-secret";
    cleanups.push(() => releaseEmailHost(root));
    await mkdir(path.join(root, "pipelines")); await mkdir(path.join(root, "stages"));
    await writeFile(path.join(root, "pipelines", "notify.yaml"), "id: notify\nstages: [notify]\n");
    await writeFile(path.join(root, "stages", "notify.yaml"), `id: notify\nmodel: model\nsystem_prompt: notify\nemail:\n  - accountId: ${account.accountId}\n    operations: [send]\n`);
    const loaded = await loadPipeline("notify", { cwd: root });
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({ pipelineId: "notify", taskYaml: "id: notification\ngoal: Notify\n" });
    let observed: StageRunInput | undefined;
    const agent = { openStage(value: StageRunInput) { observed = value; return createCompletedOnlyStageHandle({ stageId: "notify", run: async () => {
      await value.email!.send(input); return { ok: true, envelope: { status: "success", summary: "sent", artifacts: [] } };
    } }); } };
    try {
      const opened = await openStageAttempt({ agent, store, runId: run.runId, stage: loaded.stages[0], dag: loaded.dag,
        task: { id: "notification", goal: "Notify" }, workspaceDir: run.workspaceDir, factoryCwd: root });
      expect(opened.ok).toBe(true);
      if (opened.ok) { expect(await opened.handle.next()).toMatchObject({ status: "completed", result: { ok: true } }); await opened.handle.close(); }
      expect(observed?.email).toBeDefined(); expect(server.messages).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env.MAIL_SECRET; else process.env.MAIL_SECRET = previous; }
  });
  it("recreates the host adapter after same-scope shutdown", async () => {
    const { root } = await setup("local");
    const first = emailHostFor(root); await releaseEmailHost(root);
    const second = emailHostFor(root); cleanups.push(() => releaseEmailHost(root));
    expect(second.mailbox).not.toBe(first.mailbox); expect(second.accounts.list()).toHaveLength(1);
  });
  it("reports partial and total recipient rejection, and does not leak Bcc in MIME", async () => {
    const { adapter, input, server } = await setup("local", { rejectRecipient: "bad@example.com" });
    const receipt = await adapter.send({ ...input, bcc: [{ address: "bad@example.com" }, { address: "hidden@example.com" }] });
    expect(receipt.rejected).toEqual(["bad@example.com"]); expect(receipt.accepted).toHaveLength(2);
    expect(server.messages[0].data).not.toContain("Bcc:");
    await expect(adapter.send({ ...input, operationKey: "bad", to: [{ address: "bad@example.com" }] })).rejects.toMatchObject({ code: "EMAIL_RECIPIENTS_REJECTED" });
  });
  it("never resends a message whose acceptance is unknown, even after restart", async () => {
    const { adapter, accounts, input, server } = await setup("local", { dropAfterData: true });
    await expect(adapter.send(input)).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN", retryable: false });
    expect(server.messages).toHaveLength(1);
    const restarted = new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" }); cleanups.push(() => restarted.stop());
    await expect(restarted.send(input)).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
    expect(server.messages).toHaveLength(1);
  });
  it("closes a stalled submission on account disable and host stop", async () => {
    for (const action of ["disable", "stop"]) {
      const { adapter, accounts, input, server } = await setup("local", { stallAfterData: true });
      const sending = adapter.send(input);
      const outcome = expect(sending).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
      await expect.poll(() => server.messages.length).toBe(1);
      if (action === "disable") accounts.update(input.accountId, { enabled: false }); else await adapter.stop();
      await outcome; await expect.poll(() => server.sockets.size).toBe(0);
    }
  });
  it("recovers a pending record conservatively after process interruption", async () => {
    const { root, input } = await setup("memory");
    const ledger = new EmailSubmissions(root);
    void ledger.send(input, () => new Promise(() => {}));
    await expect(new EmailSubmissions(root).send(input, async () => { throw new Error("must not submit"); })).rejects.toMatchObject({ code: "EMAIL_SEND_OUTCOME_UNKNOWN" });
  });
  it("validates stage account and operation permissions", async () => {
    const { root } = await setup("memory"); const file = path.join(root, "stage.yaml");
    await writeFile(file, "id: notify\nmodel: model\nsystem_prompt: Notify\nemail:\n  - accountId: company\n    operations: [send]\n");
    expect((await loadStage(file)).email).toEqual([{ accountId: "company", operations: ["send"] }]);
    await writeFile(file, "id: notify\nmodel: model\nsystem_prompt: Notify\nemail:\n  - accountId: company\n    operations: [delete]\n");
    await expect(loadStage(file)).rejects.toThrow("invalid email permissions");
  });
});
