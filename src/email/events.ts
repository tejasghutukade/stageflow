import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EmailAccounts, type EmailAccount } from "./accounts.js";
import { EmailError, type EmailMessageSummary, type EmailReceivedEvent } from "./port.js";

/** Internal provider seam. Reads contain metadata only and use bounded UID windows. */
export interface ReceiveMailbox {
  snapshot(): Promise<{ generation: string; high: number }>;
  read(lower: number, upper: number): Promise<{ uid: number; message: EmailMessageSummary }[]>;
  next(lower: number, upper: number): Promise<number | undefined>;
  close(): void;
}
type Progress = { generation: string; uid: number };
export type ReceivedRecord = { event: EmailReceivedEvent; state: "pending" | "accepted"; acceptedAt?: string };
export type WatcherHealth = { accountId: string; folder: string; state: "starting" | "watching" | "failed"; error?: { code: string; retryable: boolean } };
type Watcher = { account: EmailAccount; folder: string; cancelled: boolean; dirty: boolean; scheduled: boolean; connection?: ReceiveMailbox; timer?: ReturnType<typeof setInterval>; work: Promise<void>; health: WatcherHealth };

/** Single host writer. A pending event blocks folder progress until its consumer accepts it. */
export class EmailEvents {
  private readonly file: string;
  private saved: { version: 1; progress: Record<string, Progress>; records: ReceivedRecord[]; faults?: Record<string, WatcherHealth> };
  private readonly watchers = new Map<string, Watcher>();
  private emit?: (event: EmailReceivedEvent) => Promise<void>;
  private unsubscribe?: () => void;
  private changes: Promise<void> = Promise.resolve();
  constructor(private readonly accounts: EmailAccounts, private readonly open: (account: EmailAccount, folder: string, signal: () => void) => Promise<ReceiveMailbox>) {
    this.file = path.join(accounts.scope, ".stageflow", "email-events.json");
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, progress: {}, records: [] };
    if (this.saved.version !== 1 || !this.saved.progress || !Array.isArray(this.saved.records)) throw new EmailError("EMAIL_INVALID_INPUT");
  }
  list(): ReceivedRecord[] { return structuredClone(this.saved.records); }
  health(): WatcherHealth[] { return [...this.watchers.values()].map(value => structuredClone(value.health)); }
  async start(emit: (event: EmailReceivedEvent) => Promise<void>): Promise<void> {
    if (this.emit) { await this.changes; return; }
    this.emit = emit;
    this.unsubscribe = this.accounts.onChange(accountId => {
      for (const watcher of this.watchers.values()) if (watcher.account.accountId === accountId) this.cancel(watcher);
      this.changes = this.changes.then(() => this.replace(accountId));
    });
    this.changes = Promise.all(this.accounts.list().map(account => this.replace(account.accountId))).then(() => {});
    await this.changes;
  }
  async stop(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    const stopping = [...this.watchers.values()];
    for (const watcher of stopping) this.cancel(watcher);
    this.emit = undefined;
    await this.changes;
    await Promise.all(stopping.map(value => value.work));
    this.watchers.clear();
  }
  private cancel(watcher: Watcher): void {
    watcher.cancelled = true; clearInterval(watcher.timer); watcher.connection?.close();
  }
  private async replace(accountId: string): Promise<void> {
    const old = [...this.watchers.entries()].filter(([, watcher]) => watcher.account.accountId === accountId);
    for (const [, watcher] of old) this.cancel(watcher);
    await Promise.all(old.map(([, watcher]) => watcher.work));
    for (const [key] of old) this.watchers.delete(key);
    const account = this.accounts.list().find(value => value.accountId === accountId && value.enabled);
    if (!account || !this.emit) return;
    await Promise.all([...new Set(account.folders)].map(async folder => {
      const key = JSON.stringify([accountId, folder]);
      const watcher: Watcher = { account, folder, cancelled: false, dirty: false, scheduled: false, work: Promise.resolve(), health: { accountId, folder, state: "starting" } };
      this.watchers.set(key, watcher);
      const signal = (): void => {
        if (watcher.cancelled) return;
        watcher.dirty = true;
        if (watcher.scheduled) return;
        watcher.scheduled = true;
        watcher.work = watcher.work.then(async () => {
          while (watcher.dirty && !watcher.cancelled) {
            watcher.dirty = false;
            await this.reconcile(key, watcher);
          }
          watcher.scheduled = false;
        });
      };
      watcher.work = (async () => {
        try {
          watcher.connection = await this.open(account, folder, signal);
          if (watcher.cancelled || !this.emit) { watcher.connection.close(); return; }
          await this.reconcile(key, watcher);
          watcher.timer = setInterval(signal, account.pollingIntervalMs);
          watcher.timer.unref();
        } catch (error) { this.fail(watcher, error); }
      })();
      await watcher.work;
    }));
  }
  private fail(watcher: Watcher, error: unknown): void {
    if (watcher.cancelled) return;
    const fault = error instanceof EmailError ? error : new EmailError("EMAIL_CONNECTION_FAILED", true);
    watcher.health = { accountId: watcher.account.accountId, folder: watcher.folder, state: "failed", error: { code: fault.code, retryable: fault.retryable } };
    this.saved.faults ??= {};
    this.saved.faults[JSON.stringify([watcher.account.accountId, watcher.folder])] = watcher.health;
    this.persist();
  }
  private async reconcile(key: string, watcher: Watcher): Promise<void> {
    if (watcher.cancelled || !watcher.connection || !this.emit) return;
    try {
      const snapshot = await watcher.connection.snapshot();
      if (!/^\d{1,20}$/.test(snapshot.generation) || !Number.isSafeInteger(snapshot.high) || snapshot.high < 0 || snapshot.high > 4294967295) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      if (watcher.cancelled) return;
      const progress = this.saved.progress[key];
      if (!progress) {
        this.saved.progress[key] = { generation: snapshot.generation, uid: snapshot.high };
        this.persist();
      } else {
        if (progress.generation !== snapshot.generation) throw new EmailError("EMAIL_STALE_REFERENCE");
        const pending = this.saved.records.filter(value => value.state === "pending" && value.event.accountId === watcher.account.accountId && value.event.message.ref.mailbox === watcher.folder);
        for (const record of pending) {
          if (watcher.cancelled || !this.emit) return;
          await this.emit(structuredClone(record.event));
          this.accept(record);
          this.persist();
        }
        while (progress.uid < snapshot.high) {
          const first = await watcher.connection.next(progress.uid + 1, snapshot.high);
          if (watcher.cancelled) return;
          if (first === undefined) { progress.uid = snapshot.high; this.persist(); break; }
          if (!Number.isSafeInteger(first) || first <= progress.uid || first > snapshot.high) throw new EmailError("EMAIL_RESOURCE_LIMIT");
          const upper = Math.min(snapshot.high, first + 99);
          const messages = await watcher.connection.read(first, upper);
          if (messages.length > 100 || new Set(messages.map(value => value.uid)).size !== messages.length || messages.some(value => !Number.isSafeInteger(value.uid) || value.uid < first || value.uid > upper)) throw new EmailError("EMAIL_RESOURCE_LIMIT");
          messages.sort((a, b) => a.uid - b.uid);
          for (const { uid, message } of messages) {
            if (watcher.cancelled || !this.emit) return;
            const eventId = createHash("sha256").update(JSON.stringify([this.accounts.scope, watcher.account.accountId, watcher.folder, snapshot.generation, uid])).digest("hex");
            let record = this.saved.records.find(value => value.event.eventId === eventId);
            if (!record) {
              if (this.saved.records.filter(value => value.state === "pending").length >= 10000) throw new EmailError("EMAIL_RESOURCE_LIMIT");
              record = { state: "pending", event: { type: "email.received", version: 1, eventId, accountId: watcher.account.accountId, message, receivedAt: message.receivedAt, detectedAt: new Date().toISOString() } };
              this.saved.records.push(record); this.persist();
            }
            if (record.state === "pending") {
              await this.emit(structuredClone(record.event));
              this.accept(record);
            }
            progress.uid = uid; this.persist();
          }
          if (watcher.cancelled) return;
          progress.uid = upper; this.persist();
        }
      }
      watcher.health = { accountId: watcher.account.accountId, folder: watcher.folder, state: "watching" };
      if (this.saved.faults?.[key]) { delete this.saved.faults[key]; this.persist(); }
    } catch (error) { this.fail(watcher, error); }
  }
  private accept(record: ReceivedRecord): void {
    record.state = "accepted";
    record.acceptedAt = new Date().toISOString();
    // Acceptance order is the stable tie-breaker when timestamps are equal.
    this.saved.records = [...this.saved.records.filter(value => value !== record), record];
  }
  private persist(): void {
    const cutoff = Date.now() - 30 * 86400000;
    const completed = this.saved.records.filter(value => value.state === "accepted" && Date.parse(value.acceptedAt!) >= cutoff)
      .sort((a, b) => Date.parse(a.acceptedAt!) - Date.parse(b.acceptedAt!)).slice(-1000);
    this.saved.records = [...this.saved.records.filter(value => value.state === "pending"), ...completed];
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
