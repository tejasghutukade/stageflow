import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { storeRootFor } from "../runstore/paths.js";
import { ChannelError, type ChannelErrorCode } from "./errors.js";
import type { SendReceipt } from "./types.js";

export type ChannelSendRecord = {
  operationId: string;
  connectionId: string;
  operationKey: string;
  hash: string;
  state: "pending" | "submitted" | "failed" | "unknown";
  createdAt: string;
  receipt?: SendReceipt;
  error?: { code: ChannelErrorCode; retryable: boolean };
};

export type ChannelSendIdentity = { connectionId: string; operationKey: string; hash: string };

const RETENTION_MS = 30 * 86400000;
const MAX_RECORDS = 10000;

/**
 * Durable record of send attempts, so a retried tool call or a resumed stage never sends twice.
 * It stores a hash of the request, never the message text. The host is the single writer.
 * A pending record that survives a crash becomes an uncertain outcome, never a resend.
 */
export class ChannelSends {
  private readonly file: string;
  private records: ChannelSendRecord[];
  private readonly active = new Map<string, Promise<SendReceipt>>();
  private accepting = true;

  constructor(scope: string) {
    this.file = path.join(storeRootFor(scope), "channel-sends.json");
    this.records = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
    for (const record of this.records) if (record.state === "pending") record.state = "unknown";
  }

  list(): ChannelSendRecord[] {
    return structuredClone(this.records);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.active.values());
  }

  setAccepting(accepting: boolean): void {
    this.accepting = accepting;
  }

  async send(identity: ChannelSendIdentity, submit: () => Promise<SendReceipt>): Promise<SendReceipt> {
    if (!this.accepting) throw new ChannelError("CHANNEL_CONNECTION_FAILED", true, { connectionId: identity.connectionId });
    const key = `${identity.connectionId}\0${identity.operationKey}`;
    const found = this.records.find(record => record.connectionId === identity.connectionId && record.operationKey === identity.operationKey);
    if (found) {
      if (found.hash !== identity.hash) throw new ChannelError("CHANNEL_OPERATION_CONFLICT", false, { connectionId: identity.connectionId });
      const active = this.active.get(key);
      if (active) return active;
      if (found.receipt) return structuredClone(found.receipt);
      if (found.state === "failed" && found.error) throw new ChannelError(found.error.code, found.error.retryable, { connectionId: identity.connectionId });
      throw new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: identity.connectionId });
    }
    const cutoff = Date.now() - RETENTION_MS;
    this.records = this.records.filter(record => !["submitted", "failed"].includes(record.state) || Date.parse(record.createdAt) >= cutoff);
    if (this.records.length >= MAX_RECORDS) throw new ChannelError("CHANNEL_RESOURCE_LIMIT", false, { connectionId: identity.connectionId });
    const record: ChannelSendRecord = {
      operationId: randomUUID(), connectionId: identity.connectionId, operationKey: identity.operationKey,
      hash: identity.hash, state: "pending", createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    this.persist();
    const work = Promise.resolve().then(submit).then(receipt => {
      record.state = "submitted";
      record.receipt = receipt;
      try {
        this.persist();
      } catch {
        return { ...structuredClone(receipt), warnings: [...(receipt.warnings ?? []), "CHANNEL_STORAGE_FAILED"] };
      }
      return structuredClone(receipt);
    }).catch(error => {
      if (record.state === "submitted") throw error;
      const fault = error instanceof ChannelError ? error : new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: identity.connectionId });
      record.state = fault.code === "CHANNEL_SEND_OUTCOME_UNKNOWN" ? "unknown" : "failed";
      record.error = { code: fault.code, retryable: fault.retryable };
      try {
        this.persist();
      } catch {
        record.state = "unknown";
        throw new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: identity.connectionId });
      }
      throw new ChannelError(fault.code, fault.retryable, { connectionId: identity.connectionId });
    }).finally(() => { this.active.delete(key); });
    this.active.set(key, work);
    return work;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
