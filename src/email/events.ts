import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EmailAccounts, type EmailAccount } from "./accounts.js";
import { decodeRef } from "./messages.js";
import { EmailError, type EmailErrorCode, type EmailMessageSummary, type EmailReceivedEvent } from "./port.js";

/** Internal provider seam. Each bounded metadata read isolates normalization faults by UID. */
export type ReceiveOutcome = { uid: number } & ({ message: EmailMessageSummary; fault?: never } | { fault: "EMAIL_INVALID_INPUT" | "EMAIL_RESOURCE_LIMIT"; message?: never });
export interface ReceiveMailbox {
  snapshot(): Promise<{ generation: string; high: number }>;
  read(lower: number, upper: number): Promise<ReceiveOutcome[]>;
  next(lower: number, upper: number): Promise<number | undefined>;
  watch?(): void;
  close(): void;
}
type Progress = { generation: string; uid: number };
type SafeError = { code: EmailErrorCode; retryable: boolean };
export type ReceivedRecord = { event: EmailReceivedEvent; state: "pending" | "accepted" | "faulted"; acceptedAt?: string; error?: SafeError };
export type MessageFault = { accountId: string; folder: string; generation: string; uid: number; code: EmailErrorCode; detectedAt: string };
export type WatcherHealth = {
  accountId: string; folder: string; state: "starting" | "watching" | "recovering" | "failed";
  error?: SafeError; storageError?: SafeError; retryAt?: string; lastAccepted?: Progress;
  reset?: { previousGeneration: string; generation: string; baseline: number; detectedAt: string };
  faults?: MessageFault[];
};
type Watcher = {
  account: EmailAccount; folder: string; cancelled: boolean; dirty: boolean; scheduled: boolean; attempts: number;
  connection?: ReceiveMailbox; timer?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>;
  work: Promise<void>; health: WatcherHealth;
};
type Saved = {
  version: 1; progress: Record<string, Progress>; records: ReceivedRecord[];
  faults?: Record<string, WatcherHealth>; messageFaults?: MessageFault[]; lastAccepted?: Record<string, Progress>;
  resets?: Record<string, NonNullable<WatcherHealth["reset"]>>;
};
/** Internal fault-injection seam. Production uses real timers and atomic file writes. */
type RecoveryDependencies = { random?: () => number; beforePersist?: () => void; afterPersist?: () => void };

/** Single host writer. A pending event blocks folder progress until its consumer accepts it. */
export class EmailEvents {
  private readonly file: string;
  private saved: Saved;
  private durable: Saved;
  private readonly watchers = new Map<string, Watcher>();
  private emit?: (event: EmailReceivedEvent) => Promise<void>;
  private unsubscribe?: () => void;
  private changes: Promise<void> = Promise.resolve();
  constructor(
    private readonly accounts: EmailAccounts,
    private readonly open: (account: EmailAccount, folder: string, signal: () => void) => Promise<ReceiveMailbox>,
    private readonly dependencies: RecoveryDependencies = {},
  ) {
    this.file = path.join(accounts.scope, ".stageflow", "email-events.json");
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, progress: {}, records: [] };
    if (this.saved.version !== 1 || !this.saved.progress || !Array.isArray(this.saved.records)) throw new EmailError("EMAIL_INVALID_INPUT");
    this.durable = structuredClone(this.saved);
  }
  list(): ReceivedRecord[] { return structuredClone(this.saved.records); }
  health(): WatcherHealth[] {
    return [...this.watchers.entries()].map(([key, watcher]) => structuredClone({
      ...watcher.health,
      ...(this.saved.lastAccepted?.[key] ? { lastAccepted: this.saved.lastAccepted[key] } : {}),
      ...(this.saved.resets?.[key] ? { reset: this.saved.resets[key] } : {}),
      ...(this.saved.messageFaults?.some(value => value.accountId === watcher.account.accountId && value.folder === watcher.folder)
        ? { faults: this.saved.messageFaults.filter(value => value.accountId === watcher.account.accountId && value.folder === watcher.folder) } : {}),
    }));
  }
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
    watcher.cancelled = true;
    clearTimeout(watcher.timer); clearTimeout(watcher.retry);
    watcher.connection?.close();
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
      const watcher: Watcher = { account, folder, cancelled: false, dirty: false, scheduled: false, attempts: 0, work: Promise.resolve(), health: { accountId, folder, state: "starting" } };
      this.watchers.set(key, watcher);
      this.signal(key, watcher);
      await watcher.work;
    }));
  }
  private signal(key: string, watcher: Watcher): void {
    if (watcher.cancelled || watcher.retry || watcher.health.state === "failed") return;
    watcher.dirty = true;
    if (watcher.scheduled) return;
    watcher.scheduled = true;
    watcher.work = watcher.work.then(async () => {
      try {
        while (watcher.dirty && !watcher.cancelled && !watcher.retry && watcher.health.state !== "failed") {
          watcher.dirty = false;
          try {
            watcher.connection ??= await this.open(watcher.account, watcher.folder, () => this.signal(key, watcher));
            if (watcher.cancelled || !this.emit) { watcher.connection.close(); break; }
            await this.reconcile(key, watcher);
            if (watcher.cancelled) break;
            watcher.connection.watch?.();
            watcher.attempts = 0;
            watcher.health = { accountId: watcher.account.accountId, folder: watcher.folder, state: "watching" };
            if (this.saved.faults?.[key]) { delete this.saved.faults[key]; this.persist(); }
            clearTimeout(watcher.timer);
            watcher.timer = setTimeout(() => this.signal(key, watcher), watcher.account.pollingIntervalMs);
            watcher.timer.unref();
          } catch (error) { this.fail(key, watcher, error); }
        }
      } finally { watcher.scheduled = false; }
    });
  }
  private fail(key: string, watcher: Watcher, error: unknown): void {
    if (watcher.cancelled) return;
    const fault = error instanceof EmailError ? error : new EmailError("EMAIL_CONNECTION_FAILED", true);
    const retryable = fault.retryable && !["EMAIL_AUTH_FAILED", "EMAIL_TOKEN_EXPIRED"].includes(fault.code);
    watcher.health = { accountId: watcher.account.accountId, folder: watcher.folder, state: retryable ? "recovering" : "failed", error: { code: fault.code, retryable } };
    clearTimeout(watcher.timer);
    if (retryable) {
      const ceiling = Math.min(watcher.account.reconnectMaxDelayMs, 1000 * 2 ** Math.min(watcher.attempts++, 22));
      const random = Math.max(0, Math.min(1, (this.dependencies.random ?? Math.random)()));
      const delay = Math.floor(ceiling * (0.5 + random * 0.5));
      watcher.health.retryAt = new Date(Date.now() + delay).toISOString();
      watcher.retry = setTimeout(() => { watcher.retry = undefined; this.signal(key, watcher); }, delay);
      watcher.retry.unref();
    }
    // Set the recovery state before close: synchronous close signals cannot queue a retry.
    watcher.connection?.close(); watcher.connection = undefined;
    this.saved.faults ??= {};
    this.saved.faults[key] = structuredClone(watcher.health);
    try { this.persist(); }
    catch {
      watcher.health.storageError = { code: "EMAIL_STORAGE_FAILED", retryable: true };
    }
  }
  private async reconcile(key: string, watcher: Watcher): Promise<void> {
    const connection = watcher.connection!;
    const snapshot = await connection.snapshot();
    if (!/^\d{1,20}$/.test(snapshot.generation) || !Number.isSafeInteger(snapshot.high) || snapshot.high < 0 || snapshot.high > 4294967295) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    if (watcher.cancelled) return;
    const progress = this.saved.progress[key];
    if (!progress || progress.generation !== snapshot.generation) {
      if (progress) {
        this.saved.resets ??= {};
        this.saved.resets[key] = { previousGeneration: progress.generation, generation: snapshot.generation, baseline: snapshot.high, detectedAt: new Date().toISOString() };
        for (const record of this.folderRecords(watcher)) {
          if (record.state !== "pending") continue;
          record.state = "faulted"; record.error = { code: "EMAIL_STALE_REFERENCE", retryable: false };
          record.acceptedAt = new Date().toISOString();
        }
      }
      this.saved.progress[key] = { generation: snapshot.generation, uid: snapshot.high };
      this.persist();
      return;
    }
    const pending = this.folderRecords(watcher).filter(value => value.state === "pending")
      .sort((a, b) => decodeRef(watcher.account, a.event.message.ref).uid - decodeRef(watcher.account, b.event.message.ref).uid);
    for (const record of pending) {
      if (watcher.cancelled || !this.emit) return;
      const reference = decodeRef(watcher.account, record.event.message.ref);
      if (reference.generation !== progress.generation) {
        record.state = "faulted"; record.error = { code: "EMAIL_STALE_REFERENCE", retryable: false }; record.acceptedAt = new Date().toISOString();
        this.persist(); continue;
      }
      await this.deliver(key, watcher, record, reference.uid);
      progress.uid = Math.max(progress.uid, reference.uid); this.persist();
    }
    while (progress.uid < snapshot.high) {
      if (watcher.cancelled) return;
      const first = await connection.next(progress.uid + 1, snapshot.high);
      if (watcher.cancelled) return;
      if (first === undefined) { progress.uid = snapshot.high; this.persist(); break; }
      if (!Number.isSafeInteger(first) || first <= progress.uid || first > snapshot.high) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      const upper = Math.min(snapshot.high, first + 99);
      const messages = await connection.read(first, upper);
      if (messages.length > 100 || new Set(messages.map(value => value.uid)).size !== messages.length || messages.some(value => !Number.isSafeInteger(value.uid) || value.uid < first || value.uid > upper)) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      messages.sort((a, b) => a.uid - b.uid);
      for (const outcome of messages) {
        if (watcher.cancelled || !this.emit) return;
        const { uid } = outcome;
        if (outcome.fault) {
          this.saved.messageFaults ??= [];
          if (!this.saved.messageFaults.some(value => value.accountId === watcher.account.accountId && value.folder === watcher.folder && value.generation === snapshot.generation && value.uid === uid)) {
            this.saved.messageFaults.push({ accountId: watcher.account.accountId, folder: watcher.folder, generation: snapshot.generation, uid, code: outcome.fault, detectedAt: new Date().toISOString() });
            this.persist();
          }
        } else {
          const eventId = createHash("sha256").update(JSON.stringify([this.accounts.scope, watcher.account.accountId, watcher.folder, snapshot.generation, uid])).digest("hex");
          let record = this.saved.records.find(value => value.event.eventId === eventId);
          if (!record) {
            if (this.saved.records.filter(value => value.state === "pending").length >= 10000) throw new EmailError("EMAIL_RESOURCE_LIMIT");
            const message = outcome.message;
            record = { state: "pending", event: { type: "email.received", version: 1, eventId, accountId: watcher.account.accountId, message, receivedAt: message.receivedAt, detectedAt: new Date().toISOString() } };
            this.saved.records.push(record); this.persist();
          }
          if (record.state === "pending") await this.deliver(key, watcher, record, uid);
        }
        progress.uid = uid; this.persist();
      }
      if (watcher.cancelled) return;
      progress.uid = upper; this.persist();
    }
  }
  private folderRecords(watcher: Watcher): ReceivedRecord[] {
    return this.saved.records.filter(value => value.event.accountId === watcher.account.accountId && value.event.message.ref.mailbox === watcher.folder);
  }
  private async deliver(key: string, watcher: Watcher, record: ReceivedRecord, uid: number): Promise<void> {
    this.persist();
    try { await this.emit!(structuredClone(record.event)); }
    catch { throw new EmailError("EMAIL_EVENT_ACCEPTANCE_FAILED", true); }
    record.state = "accepted";
    record.acceptedAt = new Date().toISOString();
    this.saved.lastAccepted ??= {};
    this.saved.lastAccepted[key] = { generation: decodeRef(watcher.account, record.event.message.ref).generation, uid };
    // Persist acceptance before checkpoint advancement. A restart uses the stable event ID.
    this.saved.records = [...this.saved.records.filter(value => value !== record), record];
    this.persist();
  }
  private persist(): void {
    const cutoff = Date.now() - 30 * 86400000;
    const completed = this.saved.records.filter(value => value.state !== "pending" && Date.parse(value.acceptedAt!) >= cutoff)
      .sort((a, b) => Date.parse(a.acceptedAt!) - Date.parse(b.acceptedAt!)).slice(-1000);
    this.saved.records = [...this.saved.records.filter(value => value.state === "pending"), ...completed];
    this.saved.messageFaults = this.saved.messageFaults?.filter(value => Date.parse(value.detectedAt) >= cutoff).slice(-1000);
    try {
      this.dependencies.beforePersist?.();
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.saved), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      this.saved = structuredClone(this.durable);
      throw new EmailError("EMAIL_STORAGE_FAILED", true);
    }
    this.durable = structuredClone(this.saved);
    this.dependencies.afterPersist?.();
  }
}
