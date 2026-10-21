import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmailAccounts, type EmailAccount } from "../src/email/accounts.js";
import { EmailEvents, type ReceiveMailbox, type ReceiveOutcome } from "../src/email/events.js";
import { messageRef } from "../src/email/messages.js";
import { EmailError, type EmailReceivedEvent } from "../src/email/port.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
async function fixture(random = 1, afterPersist?: () => void, beforePersist?: () => void) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-email-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const accounts = new EmailAccounts(root);
  const connection = { host: "localhost", port: 993, username: "user", auth: { type: "password", secretRef: "env:SECRET" } };
  const account = accounts.create({ displayName: "Inbox", address: "agent@example.com", imap: connection, smtp: connection, pollingIntervalMs: 1000, reconnectMaxDelayMs: 4000 });
  let generation = "1";
  let uids = [7];
  let connectFault: EmailError | undefined;
  let readFault: EmailError | undefined;
  const bad = new Set<number>();
  const clients: { closed: boolean; signal: () => void }[] = [];
  let attempts = 0;
  const open = vi.fn(async (receiveAccount: EmailAccount, signal: () => void): Promise<ReceiveMailbox> => {
    attempts++;
    if (connectFault) throw connectFault;
    const client = { closed: false, signal };
    clients.push(client);
    return {
      async snapshot() {
        if (client.closed) throw new EmailError("EMAIL_CONNECTION_FAILED", true);
        return { generation, high: Math.max(0, ...uids) };
      },
      async next(lower, upper) { return uids.filter(uid => uid >= lower && uid <= upper).sort((a, b) => a - b)[0]; },
      async read(lower, upper) {
        if (readFault) throw readFault;
        return uids.filter(uid => uid >= lower && uid <= upper).map((uid): ReceiveOutcome => bad.has(uid)
          ? { uid, fault: "EMAIL_RESOURCE_LIMIT" }
          : { uid, message: { ref: messageRef(receiveAccount, "INBOX", generation, uid), from: [], to: [], receivedAt: "2026-01-01T00:00:00Z", unread: true, flagged: false, subject: `Message ${uid}` } });
      },
      close() { client.closed = true; client.signal(); },
    };
  });
  const connect = async (receiveAccount: EmailAccount, _folder: string, signal: () => void): Promise<ReceiveMailbox> => {
    return open(receiveAccount, signal);
  };
  const events = new EmailEvents(accounts, connect, { random: () => random, afterPersist, beforePersist });
  cleanups.push(() => events.stop());
  vi.useFakeTimers();
  return {
    root, accounts, account, events, connect, clients, bad,
    attempts: () => attempts,
    arrive(...values: number[]) { uids.push(...values); clients.at(-1)?.signal(); },
    drop() { clients.at(-1)!.closed = true; clients.at(-1)!.signal(); },
    generation(value: string, values: number[]) { generation = value; uids = values; clients.at(-1)?.signal(); },
    connectFault(value?: EmailError) { connectFault = value; },
    readFault(value?: EmailError) { readFault = value; },
  };
}
async function settle(): Promise<void> { for (let i = 0; i < 50; i++) await Promise.resolve(); }

for (const random of [0, 1]) it(`bounds exponential recovery delay and jitter at ${random}`, async () => {
  const f = await fixture(random);
  f.connectFault(new EmailError("EMAIL_CONNECTION_FAILED", true));
  await f.events.start(async () => {});
  for (const ceiling of [1000, 2000, 4000, 4000, 4000]) {
    const delay = ceiling * (0.5 + random * 0.5);
    expect(Date.parse(f.events.health()[0].retryAt!) - Date.now()).toBe(delay);
    const before = f.attempts();
    await vi.advanceTimersByTimeAsync(delay - 1); expect(f.attempts()).toBe(before);
    await vi.advanceTimersByTimeAsync(1); expect(f.attempts()).toBe(before + 1);
  }
  await f.events.stop();
  const before = f.attempts();
  await vi.advanceTimersByTimeAsync(60000); expect(f.attempts()).toBe(before);
});

it("reconnects a dropped client and catches up before watching", async () => {
  const f = await fixture(); const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); });
  f.drop(); await settle();
  expect(f.events.health()[0].state).toBe("recovering");
  f.arrive(8, 9, 105); await settle(); expect(delivered).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.attempts()).toBe(2);
  expect(f.clients[0].closed).toBe(true);
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8", "Message 9", "Message 105"]);
  expect(f.events.health()[0]).toMatchObject({ state: "watching", lastAccepted: { generation: "1", uid: 105 } });
});

for (const code of ["EMAIL_AUTH_FAILED", "EMAIL_TOKEN_EXPIRED"] as const) it(`pauses ${code} until an account change`, async () => {
  const f = await fixture(); f.connectFault(new EmailError(code, true));
  await f.events.start(async () => {});
  expect(f.events.health()[0]).toMatchObject({ state: "failed", error: { code, retryable: false } });
  await vi.advanceTimersByTimeAsync(60000); expect(f.attempts()).toBe(1);
  f.connectFault(); f.accounts.update(f.account.accountId, { displayName: "Updated" }); await settle();
  expect(f.events.health()[0].state).toBe("watching"); expect(f.attempts()).toBe(2);
});

it("retries acceptance with one identity and blocks later messages", async () => {
  const f = await fixture(); const delivered: EmailReceivedEvent[] = []; let reject = true;
  await f.events.start(async event => { delivered.push(event); if (reject) throw new Error("PRIVATE consumer failure"); });
  f.arrive(8, 9); await settle();
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8"]);
  expect(f.events.health()[0].error?.code).toBe("EMAIL_EVENT_ACCEPTANCE_FAILED");
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered).toHaveLength(2); expect(delivered[1].eventId).toBe(delivered[0].eventId);
  reject = false; await vi.advanceTimersByTimeAsync(2000);
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8", "Message 8", "Message 8", "Message 9"]);
  expect(f.events.list().every(value => value.state === "accepted")).toBe(true);
});

it("catches up after host restart and retains metadata faults", async () => {
  const f = await fixture(); const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); }); await f.events.stop();
  f.bad.add(8); f.arrive(8, 9);
  const restarted = new EmailEvents(new EmailAccounts(f.root), f.connect);
  cleanups.push(() => restarted.stop());
  await restarted.start(async event => { delivered.push(event); });
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 9"]);
  expect(restarted.health()[0].faults).toMatchObject([{ uid: 8, generation: "1", code: "EMAIL_RESOURCE_LIMIT" }]);
  await restarted.stop();
  const next = new EmailEvents(f.accounts, f.connect); cleanups.push(() => next.stop());
  await next.start(async event => { delivered.push(event); });
  expect(delivered).toHaveLength(1); expect(next.health()[0].faults).toHaveLength(1);
});

it("faults old pending events on reset and never reroutes an old UID", async () => {
  const f = await fixture(); const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); throw new Error("pending"); });
  f.arrive(8); await settle(); const old = delivered[0].message.ref;
  f.generation("2", [1, 8]); await vi.advanceTimersByTimeAsync(1000);
  expect(delivered).toHaveLength(1);
  expect(f.events.list()[0]).toMatchObject({ state: "faulted", error: { code: "EMAIL_STALE_REFERENCE", retryable: false } });
  expect(f.events.list()[0].event.message.ref).toEqual(old);
  expect(f.events.health()[0]).toMatchObject({ state: "watching", reset: { previousGeneration: "1", generation: "2", baseline: 8 } });
  await f.events.stop();
  await f.events.start(async event => { delivered.push(event); });
  f.arrive(9); await settle();
  expect(delivered).toHaveLength(2); expect(delivered[1].eventId).not.toBe(delivered[0].eventId);
});

it("cancels a removed account retry and leaves no timers after stop", async () => {
  const f = await fixture(); f.connectFault(new EmailError("EMAIL_TIMEOUT", true));
  await f.events.start(async () => {});
  f.accounts.remove(f.account.accountId); await settle();
  expect(f.events.health()).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000); expect(f.attempts()).toBe(1);
  await f.events.stop(); expect(vi.getTimerCount()).toBe(0);
});

it("recovers the acceptance/checkpoint crash window without duplicate consumer delivery", async () => {
  let crash = false; let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(1, () => {
    if (!crash) return;
    const saved = JSON.parse(readFileSync(path.join(f.root, ".stageflow", "email-events.json"), "utf8"));
    if (!saved.records.some((value: { state: string }) => value.state === "accepted")) return;
    crash = false; void f.events.stop(); throw new Error("injected host crash");
  });
  const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); }); crash = true;
  f.arrive(8, 9); await settle(); await f.events.stop();
  const saved = JSON.parse(await readFile(path.join(f.root, ".stageflow", "email-events.json"), "utf8"));
  expect(saved.progress[JSON.stringify([f.account.accountId, "INBOX"])].uid).toBe(7);
  expect(saved.records[0].state).toBe("accepted");
  const restarted = new EmailEvents(f.accounts, f.connect); cleanups.push(() => restarted.stop());
  await restarted.start(async event => { delivered.push(event); });
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8", "Message 9"]);
  expect(restarted.list()[0].event.eventId).toBe(delivered[0].eventId);
});

it("keeps recovery active through persistent storage failure and retries from durable progress", async () => {
  let unavailable = false;
  const f = await fixture(1, undefined, () => { if (unavailable) throw new Error("PRIVATE disk path"); });
  const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); });
  unavailable = true; f.arrive(8, 9); await settle();
  expect(f.events.health()[0]).toMatchObject({ state: "recovering", error: { code: "EMAIL_STORAGE_FAILED", retryable: true }, storageError: { code: "EMAIL_STORAGE_FAILED" } });
  await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(2000);
  expect(f.attempts()).toBe(3); expect(delivered).toHaveLength(0);
  expect(f.events.list()).toHaveLength(0);
  unavailable = false; await vi.advanceTimersByTimeAsync(4000);
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8", "Message 9"]);
  expect(f.events.health()[0]).toMatchObject({ state: "watching", lastAccepted: { uid: 9 } });
  expect(f.events.health()[0].storageError).toBeUndefined();
});

it("keeps a second account active while the first consumer is failing", async () => {
  const f = await fixture();
  const { accountId: _id, scope: _scope, ...config } = f.account;
  const second = f.accounts.create({ ...config, address: "second@example.com" });
  const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => {
    delivered.push(event);
    if (event.accountId === f.account.accountId) throw new Error("first account consumer down");
  });
  f.arrive(8, 9); f.clients[0].signal(); await settle();
  expect(delivered.filter(value => value.accountId === second.accountId).map(value => value.message.subject)).toEqual(["Message 8", "Message 9"]);
  expect(delivered.filter(value => value.accountId === f.account.accountId)).toHaveLength(1);
  expect(f.events.health().find(value => value.accountId === second.accountId)?.state).toBe("watching");
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered.filter(value => value.accountId === second.accountId)).toHaveLength(2);
});

it("retries a failed acceptance persist with the same identity", async () => {
  let unavailable = false;
  const f = await fixture(1, undefined, () => { if (unavailable) throw new Error("disk full"); });
  const delivered: EmailReceivedEvent[] = [];
  await f.events.start(async event => { delivered.push(event); unavailable = true; });
  f.arrive(8, 9); await settle();
  expect(delivered).toHaveLength(1); expect(f.events.list()[0].state).toBe("pending");
  await vi.advanceTimersByTimeAsync(1000); expect(delivered).toHaveLength(1);
  unavailable = false;
  await f.events.stop();
  await f.events.start(async event => { delivered.push(event); });
  expect(delivered.map(value => value.message.subject)).toEqual(["Message 8", "Message 8", "Message 9"]);
  expect(delivered[0].eventId).toBe(delivered[1].eventId);
});
