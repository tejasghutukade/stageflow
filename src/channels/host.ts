import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { StageChannel, StageConfig } from "../types/stage.js";
import { ChannelRegistry, connectionsFilePath, type ChannelRegistryOptions } from "./registry.js";
import { loadConnectionsFile } from "./config.js";
import { ChannelError, type ChannelErrorCode } from "./errors.js";
import { ChannelSends } from "./ledger.js";
import { channelKey, channelTarget, validateStageChannels } from "./stageChannels.js";
import type { OutboundMessage, SendReceipt } from "./types.js";

export type ChannelSendInput = { channel?: string; text: string; subject?: string; operationKey: string };
export type ChannelSendResult = {
  channel: string;
  connection: string;
  providerMessageId?: string;
  submittedAt: string;
  warnings?: string[];
};
export type StageChannels = { send(input: ChannelSendInput): Promise<ChannelSendResult> };

export const MAX_MESSAGE_TEXT = 65536;
const WORKER_TIMEOUT_MS = 65000;

const sendSchema = z.object({
  channel: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(MAX_MESSAGE_TEXT),
  subject: z.string().min(1).max(998).regex(/^[^\r\n]*$/).optional(),
  operationKey: z.string().min(1).max(120),
}).strict();

export class ChannelHost {
  registry: ChannelRegistry;
  readonly sends: ChannelSends;
  constructor(private readonly cwd: string, private readonly options: Omit<ChannelRegistryOptions, "cwd"> = {}) {
    this.registry = new ChannelRegistry({ cwd, ...options });
    this.sends = new ChannelSends(this.registry.scope);
  }

  /** Re-reads connections.yaml after an edit. A file that no longer loads keeps the old registry. */
  reload(): void {
    this.registry = new ChannelRegistry({ cwd: this.cwd, ...this.options });
  }
}

const hosts = new Map<string, { host: ChannelHost; releasing?: Promise<void> }>();

export function channelHostFor(cwd: string): ChannelHost {
  const key = path.resolve(cwd);
  let entry = hosts.get(key);
  if (entry?.releasing) throw new ChannelError("CHANNEL_CONNECTION_FAILED", true);
  if (!entry) {
    entry = { host: new ChannelHost(key) };
    hosts.set(key, entry);
  }
  return entry.host;
}

export async function releaseChannelHost(cwd: string): Promise<void> {
  const key = path.resolve(cwd);
  const entry = hosts.get(key);
  if (!entry) return;
  entry.releasing ??= (async () => {
    entry.host.sends.setAccepting(false);
    await entry.host.sends.drain();
  })();
  await entry.releasing;
  if (hosts.get(key) === entry) hosts.delete(key);
}

/** Fails with the first problem found. Static only: no network, no secret reads. */
export function validateStageChannelConnections(host: ChannelHost, stage: Pick<StageConfig, "id" | "channels">): void {
  const [first] = validateStageChannels(host.registry, stage);
  if (first) throw new ChannelError(first.code, false, { connectionId: stage.channels?.find(channel => channelKey(channel) === first.key)?.connection });
}

/**
 * Removes every variable that `connections.yaml` points at, and its `_FILE` form, from a
 * worker environment. A file that cannot be read leaves the environment unchanged.
 */
export function channelsWorkerEnvironment(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const result = { ...env };
  let file;
  try {
    file = loadConnectionsFile(connectionsFilePath(cwd));
  } catch {
    return result;
  }
  for (const entry of [...file.credentials, ...file.connections]) {
    for (const ref of Object.values(entry.secrets)) {
      if (!ref.startsWith("env:")) continue;
      const name = ref.slice("env:".length);
      delete result[name];
      delete result[`${name}_FILE`];
    }
  }
  return result;
}

function pick(channels: readonly StageChannel[], requested: string | undefined): StageChannel {
  if (requested !== undefined) {
    const found = channels.find(channel => channelKey(channel) === requested);
    if (!found) throw new ChannelError("CHANNEL_UNAUTHORIZED");
    return found;
  }
  if (channels.length === 1) return channels[0]!;
  throw new ChannelError("CHANNEL_INVALID_INPUT", false, { field: "channel" });
}

function hashOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Host-side authorization and delivery for one stage. The target comes from the stage's
 * frozen `channels`, never from the caller. The caller's operation key is bound to the run,
 * stage and channel before it reaches the ledger.
 */
export function stageChannels(host: ChannelHost, stage: StageConfig, runId: string): StageChannels {
  const declared = structuredClone(stage.channels ?? []);
  const stageId = stage.id;
  return {
    async send(raw) {
      const parsed = sendSchema.safeParse(raw);
      if (!parsed.success) throw new ChannelError("CHANNEL_INVALID_INPUT");
      const input = parsed.data;
      const channel = pick(declared, input.channel);
      if (!channel.operations.includes("send")) throw new ChannelError("CHANNEL_UNAUTHORIZED", false, { connectionId: channel.connection });
      const key = channelKey(channel);
      const target = host.registry.validateTarget(channel.connection, channelTarget(channel));
      const provider = host.registry.providerFor(channel.connection);
      const connection = host.registry.resolve(channel.connection);
      const message: OutboundMessage = { text: input.text, ...(input.subject !== undefined ? { subject: input.subject } : {}) };
      const operationKey = hashOf([runId, stageId, key, input.operationKey]);
      const receipt: SendReceipt = await host.sends.send(
        { connectionId: channel.connection, operationKey, hash: hashOf([key, channel.connection, channelTarget(channel), message]) },
        () => provider.send(connection, target, message, { operationKey, runId, stageId }),
      );
      return {
        channel: key,
        connection: channel.connection,
        ...(receipt.providerMessageId !== undefined ? { providerMessageId: receipt.providerMessageId } : {}),
        submittedAt: receipt.submittedAt,
        ...(receipt.warnings?.length ? { warnings: receipt.warnings } : {}),
      };
    },
  };
}

export function channelFault(error: unknown): { code: ChannelErrorCode; retryable: boolean } {
  return error instanceof ChannelError
    ? { code: error.code, retryable: error.retryable }
    : { code: "CHANNEL_CONNECTION_FAILED", retryable: false };
}

/** The inherited IPC channel identifies the child; no caller-provided run or stage identity is accepted. */
export function workerStageChannels(): StageChannels {
  return {
    send(input) {
      return new Promise((resolve, reject) => {
        if (!process.connected || !process.send) { reject(new ChannelError("CHANNEL_UNAUTHORIZED")); return; }
        const requestId = randomUUID();
        const finish = (error?: ChannelError, result?: ChannelSendResult): void => {
          clearTimeout(timer);
          process.off("message", receive);
          process.off("disconnect", disconnected);
          if (error) reject(error); else resolve(result!);
        };
        const disconnected = (): void => finish(new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN"));
        const receive = (message: unknown): void => {
          const response = message as { type?: string; requestId?: string; receipt?: ChannelSendResult; error?: { code: ChannelErrorCode; retryable: boolean } };
          if (response?.type !== "channel.response" || response.requestId !== requestId) return;
          finish(response.error ? new ChannelError(response.error.code, response.error.retryable) : undefined, response.receipt);
        };
        const timer = setTimeout(disconnected, WORKER_TIMEOUT_MS);
        process.on("message", receive);
        process.once("disconnect", disconnected);
        process.send({ type: "channel.send", requestId, input }, error => { if (error) disconnected(); });
      });
    },
  };
}
