import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmailAccounts } from "../src/email/accounts.js";
import { InMemoryEmailAdapter, LocalEmailAdapter } from "../src/email/adapter.js";
import type { EmailReceivedEvent } from "../src/email/port.js";
import type { MailRecord } from "../src/email/messages.js";
import { mailServer } from "./fixtures/mailServers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function record(uid: number): MailRecord {
  return { uid, source: Buffer.from(`From: sender@example.com\r\nTo: agent@example.com\r\nSubject: Message ${uid}\r\n\r\nPRIVATE BODY`), flags: new Set(), receivedAt: new Date("2026-01-01T12:00:00Z") };
}
async function setup(kind: "memory" | "local", idle = true, faults: { stallSelection?: boolean; stallFetch?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-email-events-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = await mailServer("imap", { idle, ...faults, mailboxMessages: [record(7)] }); cleanups.push(() => server.close());
  const accounts = new EmailAccounts(root);
  const connection = { host: "127.0.0.1", port: server.port, username: "user", tls: "none", auth: { type: "password", secretRef: "env:MAIL_SECRET" } };
  const account = accounts.create({ displayName: "Inbox", address: "agent@example.com", imap: connection, smtp: connection, allowInsecureLocalDevelopment: true, pollingIntervalMs: 1000, connectionTimeoutMs: 2000 });
  const adapter = kind === "memory" ? new InMemoryEmailAdapter(accounts) : new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" });
  if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages);
  cleanups.push(() => adapter.stop());
  function arrive(...uids: number[]): void {
    server.mailbox.messages.push(...uids.map(record));
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages);
    else if (idle) server.signal();
  }
  return { root, server, accounts, account, adapter, arrive };
}
for (const kind of ["memory", "local"] as const) describe(`${kind} incoming event contract`, () => {
  it("baselines without history, finds all arrivals, and starts once", async () => {
    const { root, adapter, arrive, server } = await setup(kind);
    const received: EmailReceivedEvent[] = [];
    await adapter.start(async event => { received.push(event); });
    await adapter.start(async () => { throw new Error("duplicate consumer"); });
    expect(received).toEqual([]);
    arrive(8, 9, 120);
    await expect.poll(() => received.length).toBe(3);
    expect(received.map(event => event.message.subject)).toEqual(["Message 8", "Message 9", "Message 120"]);
    expect(new Set(received.map(event => event.eventId)).size).toBe(3);
    expect(adapter.events.list().every(value => value.state === "accepted")).toBe(true);
    const saved = await readFile(path.join(root, ".stageflow", "email-events.json"), "utf8");
    expect(saved).not.toContain("PRIVATE BODY"); expect(saved).not.toContain("fixture-secret");
    expect(server.fetchedSourceBytes).toEqual([]);
    expect(server.mailbox.messages.every(value => !value.flags.has("\\Seen"))).toBe(true);
    await adapter.stop(); arrive(121);
    expect(received).toHaveLength(3);
  });
  it("keeps failed acceptance pending, retries the same event, and blocks later progress", async () => {
    const { adapter, arrive } = await setup(kind);
    const deliveries: string[] = [];
    let fail = true;
    await adapter.start(async event => { deliveries.push(event.eventId); if (fail) throw new Error("not durable"); });
    arrive(8, 9);
    await expect.poll(() => adapter.events.list().length).toBe(1);
    expect(adapter.events.list()[0].state).toBe("pending");
    fail = false;
    await expect.poll(() => adapter.events.list().filter(value => value.state === "accepted").length, { timeout: 4000 }).toBe(2);
    expect(deliveries[0]).toBe(deliveries[1]);
    expect(new Set(deliveries).size).toBe(2);
  });
  it("waits for an in-flight consumer before stop resolves", async () => {
    const { adapter, arrive } = await setup(kind);
    let release!: () => void;
    let delivering = false;
    await adapter.start(async () => { delivering = true; await new Promise<void>(resolve => { release = resolve; }); });
    arrive(8, 9);
    await expect.poll(() => delivering).toBe(true);
    let stopped = false;
    const stop = adapter.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await stop;
    expect(adapter.events.list()).toHaveLength(1);
  });
  it("stops a disabled account and resumes without replay", async () => {
    const { adapter, accounts, account, arrive } = await setup(kind);
    const received: EmailReceivedEvent[] = [];
    await adapter.start(async event => { received.push(event); });
    accounts.update(account.accountId, { enabled: false });
    await expect.poll(() => adapter.events.health().length).toBe(0);
    arrive(8);
    expect(received).toEqual([]);
    accounts.update(account.accountId, { enabled: true });
    await expect.poll(() => received.length).toBe(1);
  });
  it("keeps folder and account watchers separate and isolates faults", async () => {
    const { adapter, accounts, account, server, arrive } = await setup(kind);
    server.mailboxes.set("Archive", { generation: "2", messages: [record(4)] });
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, [record(4)], "Archive", "2");
    accounts.update(account.accountId, { folders: ["INBOX", "Archive"] });
    const { accountId: _id, scope: _scope, ...config } = account;
    accounts.create({ ...config, imap: { ...config.imap, auth: { type: "password", secretRef: "env:ABSENT" } } });
    const received: EmailReceivedEvent[] = [];
    await adapter.start(async event => { received.push(event); });
    expect(adapter.events.health().filter(value => value.accountId === account.accountId)).toEqual([
      { accountId: account.accountId, folder: "INBOX", state: "watching" }, { accountId: account.accountId, folder: "Archive", state: "watching" },
    ]);
    arrive(8);
    server.mailboxes.get("Archive")!.messages.push(record(5));
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailboxes.get("Archive")!.messages, "Archive", "2");
    else server.signal("Archive");
    await expect.poll(() => received.length).toBe(2);
    expect(new Set(received.map(event => event.message.ref.mailbox))).toEqual(new Set(["INBOX", "Archive"]));
    if (kind === "local") expect(adapter.events.health().some(value => value.state === "failed")).toBe(true);
    accounts.remove(account.accountId);
    await expect.poll(() => adapter.events.health().filter(value => value.accountId === account.accountId).length).toBe(0);
  });
  it("recovers a pending event with the same identity after adapter restart", async () => {
    const { adapter, accounts, account, server, root, arrive } = await setup(kind);
    await adapter.start(async () => { throw new Error("consumer unavailable"); });
    arrive(8);
    await expect.poll(() => adapter.events.list().length).toBe(1);
    const eventId = adapter.events.list()[0].event.eventId;
    await adapter.stop();
    const next = kind === "memory" ? new InMemoryEmailAdapter(new EmailAccounts(root)) : new LocalEmailAdapter(accounts, { MAIL_SECRET: "fixture-secret" });
    if (next instanceof InMemoryEmailAdapter) next.seedMailbox(account.accountId, server.mailbox.messages);
    cleanups.push(() => next.stop());
    const received: EmailReceivedEvent[] = [];
    await next.start(async event => { received.push(event); });
    expect(received.map(event => event.eventId)).toEqual([eventId]);
  });
  it("uses bounded metadata for malformed headers and faults on changed folder identity", async () => {
    const { adapter, account, server } = await setup(kind);
    const received: EmailReceivedEvent[] = [];
    await adapter.start(async event => { received.push(event); });
    const malformed = record(8); malformed.source = Buffer.from(`Subject: ${"x".repeat(5000)}\r\nFrom: broken\r\n\r\nPRIVATE BODY`);
    server.mailbox.messages.push(malformed);
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages); else server.signal();
    await expect.poll(() => received.length).toBe(1);
    expect(received[0].message.subject!.length).toBeLessThanOrEqual(4096);
    server.mailbox.generation = "9";
    if (adapter instanceof InMemoryEmailAdapter) adapter.seedMailbox(account.accountId, server.mailbox.messages, "INBOX", "9");
    else { await adapter.stop(); await adapter.start(async event => { received.push(event); }); }
    await expect.poll(() => adapter.events.health()[0].error?.code).toBe("EMAIL_STALE_REFERENCE");
    expect(received).toHaveLength(1);
  });
});
it("keeps recent completed metadata, unresolved work, and durable dedupe after retention", async () => {
  const { adapter, root, accounts, account, server } = await setup("memory");
  await adapter.start(async () => {});
  const message = (await adapter.search({ accountId: account.accountId })).messages[0];
  await adapter.stop();
  const file = path.join(root, ".stageflow", "email-events.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const acceptedAt = new Date().toISOString();
  saved.records = Array.from({ length: 1005 }, (_, index) => ({ state: "accepted", acceptedAt, event: { type: "email.received", version: 1, eventId: `old-${index}`, accountId: account.accountId, message, receivedAt: message.receivedAt, detectedAt: message.receivedAt } }));
  await writeFile(file, JSON.stringify(saved));
  const next = new InMemoryEmailAdapter(accounts); cleanups.push(() => next.stop());
  next.seedMailbox(account.accountId, [...server.mailbox.messages, record(8)]);
  const received: EmailReceivedEvent[] = [];
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(acceptedAt));
  await next.start(async event => { received.push(event); });
  vi.useRealTimers();
  expect(next.events.list()).toHaveLength(1000);
  expect(next.events.list().at(-1)!.event.eventId).toBe(received[0].eventId);
  await next.stop();
  const third = new InMemoryEmailAdapter(accounts); cleanups.push(() => third.stop());
  third.seedMailbox(account.accountId, [record(7), record(8)]);
  await third.start(async event => { received.push(event); });
  expect(received).toHaveLength(1);
});
it("polls a provider without IDLE", async () => {
  const { adapter, arrive, server } = await setup("local", false);
  const received: EmailReceivedEvent[] = [];
  await adapter.start(async event => { received.push(event); });
  arrive(8, 9);
  await expect.poll(() => received.length, { timeout: 4000 }).toBe(2);
  expect(server.commands).not.toContain("IDLE");
});
for (const fault of ["stallSelection", "stallFetch"] as const) it(`cancels ${fault} on stop while start is pending`, async () => {
  const { adapter, server } = await setup("local", true, { [fault]: true });
  const start = adapter.start(async () => {});
  await expect.poll(() => server.commands.includes(fault === "stallSelection" ? "EXAMINE" : "FETCH")).toBe(true);
  await adapter.stop(); await start;
  await expect.poll(() => server.sockets.size).toBe(0);
  expect(adapter.events.health()).toEqual([]);
});
