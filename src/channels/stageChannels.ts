import { z } from "zod";
import type { StageChannel, StageConfig } from "../types/stage.js";
import { ChannelError, type ChannelErrorCode } from "./errors.js";
import type { ChannelRegistry } from "./registry.js";

export const MAX_STAGE_CHANNELS = 20;

/**
 * Policy, not capability: how many channels one stage may use. Everything below (merge by alias,
 * picking by name, the per-channel ledger key) still handles several, so raising this one number
 * is all it takes to enable them. It is enforced where a stage is parsed, merged, validated and
 * at the moment of sending, so no single entry point can bypass it.
 */
export const MAX_CHANNELS_PER_STAGE = 1;
let channelLimit = MAX_CHANNELS_PER_STAGE;

export function stageChannelLimit(): number {
  return channelLimit;
}

/** Tests that exercise multi-channel behavior raise the policy for their own duration. */
export function setStageChannelLimitForTests(limit: number): () => void {
  const previous = channelLimit;
  channelLimit = limit;
  return () => { channelLimit = previous; };
}

export function channelLimitMessage(count?: number): string {
  const limit = channelLimit;
  return `a stage can use ${limit === 1 ? "one channel" : `at most ${limit} channels`} for now${count === undefined ? "" : ` (this one has ${count})`}; split the work into separate stages`;
}
export const MAX_CHANNEL_TARGETS = 20;

const targetSchema = z.union([z.string().min(1).max(500), z.number().int().refine(Number.isSafeInteger).transform(String)]);
const channelSchema = z.object({
  alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/).optional(),
  connection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
  operations: z.array(z.enum(["send"])).min(1).max(1),
  to: z.union([targetSchema, z.array(targetSchema).min(1).max(MAX_CHANNEL_TARGETS)]),
  cc: z.array(targetSchema).min(1).max(MAX_CHANNEL_TARGETS).optional(),
  template: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ParsedChannels = { ok: true; value: StageChannel[] } | { ok: false; message: string };

export function channelKey(channel: Pick<StageChannel, "alias" | "connection">): string {
  return channel.alias ?? channel.connection;
}

/** Shape check only. Whether the connection exists is checked against `connections.yaml` later. */
export function parseChannels(raw: unknown): ParsedChannels {
  if (Array.isArray(raw) && raw.length > channelLimit) return { ok: false, message: `channels: ${channelLimitMessage(raw.length)}` };
  const parsed = z.array(channelSchema).max(MAX_STAGE_CHANNELS).safeParse(raw);
  if (!parsed.success) return { ok: false, message: "channels must be a list of { connection, to, operations: [send] } entries (optional alias, cc, template)" };
  const keys = parsed.data.map(channelKey);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, message: "channels entries must have unique aliases; give each entry for the same connection its own alias" };
  }
  return { ok: true, value: parsed.data as StageChannel[] };
}

/**
 * Pipeline `channels` are defaults. A stage that declares its own list merges by alias (or
 * connection id when there is no alias) with the stage entry winning. An explicit empty
 * list clears every inherited entry.
 */
export function mergeChannelDefaults(
  defaults: readonly StageChannel[] | undefined,
  own: readonly StageChannel[] | undefined,
): StageChannel[] | undefined {
  if (own === undefined) return defaults === undefined ? undefined : structuredClone([...defaults]);
  if (own.length === 0) return [];
  const merged = new Map<string, StageChannel>();
  for (const channel of defaults ?? []) merged.set(channelKey(channel), channel);
  for (const channel of own) merged.set(channelKey(channel), channel);
  return structuredClone([...merged.values()]);
}

export type StageChannelIssue = {
  stageId: string;
  key: string;
  code: ChannelErrorCode;
  message: string;
};

export function channelTarget(channel: StageChannel): { to: string | string[]; cc?: string[]; template?: Record<string, unknown> } {
  return {
    to: channel.to,
    ...(channel.cc !== undefined ? { cc: channel.cc } : {}),
    ...(channel.template !== undefined ? { template: channel.template } : {}),
  };
}

/** Static checks against `connections.yaml`. No network and no secret reads. */
export function validateStageChannels(registry: ChannelRegistry, stage: Pick<StageConfig, "id" | "channels">): StageChannelIssue[] {
  const issues: StageChannelIssue[] = [];
  const count = stage.channels?.length ?? 0;
  if (count > channelLimit) {
    issues.push({ stageId: stage.id, key: stage.channels![0] ? channelKey(stage.channels![0]) : "", code: "CHANNEL_INVALID_INPUT", message: `stage "${stage.id}": ${channelLimitMessage(count)}` });
  }
  for (const channel of stage.channels ?? []) {
    const key = channelKey(channel);
    const fail = (code: ChannelErrorCode, message: string): void => {
      issues.push({ stageId: stage.id, key, code, message });
    };
    try {
      registry.get(channel.connection);
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
      fail(error.code, error.code === "CHANNEL_DISABLED"
        ? `channel "${key}": connection "${channel.connection}" is disabled`
        : `channel "${key}": connection "${channel.connection}" is not defined in connections.yaml`);
      continue;
    }
    const provider = registry.providerFor(channel.connection);
    const unsupported = channel.operations.find(operation => !provider.operations.includes(operation));
    if (unsupported) {
      fail("CHANNEL_INVALID_INPUT", `channel "${key}": provider "${provider.id}" does not support "${unsupported}"`);
      continue;
    }
    const target = provider.validateTarget(channelTarget(channel));
    if (!target.ok) {
      fail("CHANNEL_TARGET_INVALID", `channel "${key}": invalid target for ${provider.id} (${target.issues.join(", ")})`);
    }
  }
  return issues;
}
