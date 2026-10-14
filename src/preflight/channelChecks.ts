import { ChannelError, type ChannelErrorCode } from "../channels/errors.js";
import { ChannelRegistry } from "../channels/registry.js";
import { channelTarget } from "../channels/stageChannels.js";
import type { AnyChannelProvider, ConnectionHealth } from "../channels/types.js";
import type { LoadedPipeline } from "../types/pipeline.js";
import type { PreflightItem } from "./pipelinePreflight.js";

export type ChannelCheckOptions = {
  projectRoot: string;
  hostEnv?: NodeJS.ProcessEnv;
  providers?: readonly AnyChannelProvider[];
  /** Waits between attempts. Each entry allows one more retry. */
  retryDelaysMs?: readonly number[];
  attemptTimeoutMs?: number;
};

export const DEFAULT_CHANNEL_RETRY_DELAYS_MS = [500, 1500] as const;
export const DEFAULT_CHANNEL_ATTEMPT_TIMEOUT_MS = 8000;

function failed(code: ChannelErrorCode, retryable: boolean): ConnectionHealth {
  return { state: "failed", checkedAt: new Date().toISOString(), error: { code, retryable } };
}

async function attempt(run: (signal: AbortSignal) => Promise<ConnectionHealth>, timeoutMs: number): Promise<ConnectionHealth> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ConnectionHealth>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(failed("CHANNEL_TIMEOUT", true)); }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } catch (error) {
    return error instanceof ChannelError
      ? failed(error.code, error.retryable)
      : failed("CHANNEL_CONNECTION_FAILED", false);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries only failures the provider marked transient. Authentication, configuration,
 * permission and target problems return at once so a bad setup is never slowed or hidden.
 */
async function withRetry(
  run: (signal: AbortSignal) => Promise<ConnectionHealth>,
  options: { delays: readonly number[]; timeoutMs: number },
): Promise<ConnectionHealth> {
  let result = await attempt(run, options.timeoutMs);
  for (const delay of options.delays) {
    if (result.state === "ok" || result.error?.retryable !== true) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    result = await attempt(run, options.timeoutMs);
  }
  return result;
}

function item(connection: string, health: ConnectionHealth): PreflightItem {
  if (health.state === "ok") return { kind: "channel", status: "ok", connection };
  const code = health.error?.code ?? "CHANNEL_CONNECTION_FAILED";
  return {
    kind: "channel", status: "channel_check_failed", connection, channelCode: code,
    retryable: health.error?.retryable ?? false, message: `connection "${connection}": ${code}`,
  };
}

/** Live check of every connection a pipeline's stages declare. Never sends a message. */
export async function checkStageChannels(loaded: LoadedPipeline, options: ChannelCheckOptions): Promise<PreflightItem[]> {
  const targetsByConnection = new Map<string, Map<string, unknown>>();
  for (const stage of loaded.stages) {
    for (const channel of stage.channels ?? []) {
      const targets = targetsByConnection.get(channel.connection) ?? new Map<string, unknown>();
      targets.set(JSON.stringify(channelTarget(channel)), channelTarget(channel));
      targetsByConnection.set(channel.connection, targets);
    }
  }
  if (targetsByConnection.size === 0) return [];

  let registry: ChannelRegistry;
  try {
    registry = new ChannelRegistry({ cwd: options.projectRoot, env: options.hostEnv, providers: options.providers });
  } catch (error) {
    const code = error instanceof ChannelError ? error.code : "CHANNEL_INVALID_INPUT";
    return [...targetsByConnection.keys()].map(connection => item(connection, failed(code, false)));
  }

  const retry = {
    delays: options.retryDelaysMs ?? DEFAULT_CHANNEL_RETRY_DELAYS_MS,
    timeoutMs: options.attemptTimeoutMs ?? DEFAULT_CHANNEL_ATTEMPT_TIMEOUT_MS,
  };
  return Promise.all([...targetsByConnection].map(async ([id, targets]): Promise<PreflightItem> => {
    let resolved;
    let provider: AnyChannelProvider;
    try {
      provider = registry.providerFor(id);
      resolved = registry.resolve(id);
    } catch (error) {
      return item(id, error instanceof ChannelError ? failed(error.code, false) : failed("CHANNEL_CONNECTION_FAILED", false));
    }
    const health = await withRetry(signal => provider.check(resolved, signal), retry);
    if (health.state !== "ok" || !provider.checkTargets) return item(id, health);
    const validated = [...targets.values()].map(target => provider.validateTarget(target));
    if (validated.some(result => !result.ok)) return item(id, failed("CHANNEL_TARGET_INVALID", false));
    const values = validated.flatMap(result => (result.ok ? [result.value] : []));
    return item(id, await withRetry(signal => provider.checkTargets!(resolved, values, signal), retry));
  }));
}

const FAILURE_REASONS: Record<string, string> = {
  CHANNEL_RECIPIENT_REJECTED: "the provider will not message the pinned recipient (for iMessage on a Free or Pro Photon project, register that person in the project)",
  CHANNEL_TARGET_INVALID: "the pinned recipient is not valid for this provider",
  CHANNEL_SECRET_UNAVAILABLE: "a secret for this connection is not set on the host",
  CHANNEL_AUTH_FAILED: "the provider rejected the credentials",
  CHANNEL_UNAUTHORIZED: "the provider refused the credentials or they lack a permission",
  CHANNEL_INVALID_INPUT: "the connection settings do not match the provider account",
  CHANNEL_CONNECTION_FAILED: "the provider could not be reached",
  CHANNEL_TIMEOUT: "the provider did not answer in time",
  CHANNEL_RATE_LIMIT: "the provider is rate limiting this account",
  CHANNEL_PROVIDER_UNSUPPORTED: "the provider is not supported here, or its Spectrum SDK packages are not installed",
  CHANNEL_NOT_FOUND: "the connection is not defined",
  CHANNEL_DISABLED: "the connection is disabled",
};

/** One line naming each failed connection and why. Codes and plain reasons only, never a secret. */
export function channelFailureSummary(checks: readonly PreflightItem[]): string | undefined {
  const failed = checks.filter(check => check.kind === "channel" && check.status === "channel_check_failed");
  if (failed.length === 0) return undefined;
  return failed
    .map(check => {
      const code = check.channelCode ?? "CHANNEL_CONNECTION_FAILED";
      return `${check.connection}: ${FAILURE_REASONS[code] ?? code} (${code})`;
    })
    .join("; ");
}
