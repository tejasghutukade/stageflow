import { ChannelError } from "../channels/errors.js";
import type { SecretReader } from "../channels/secretStore.js";
import type { SecretWriter } from "../channels/connectionEdits.js";
import type { TriggerEvent, TriggerFile } from "../types/trigger.js";
import {
  storeNameOfRef,
  TRIGGER_STORE_PREFIX,
  triggerSecretStoreName,
  triggerSourceTakesSecret,
} from "./triggerSecret.js";

export type TriggerSecretRequest = { secret?: string; clear: boolean };
export type TriggerSecretFailure = { ok: false; status: 400 | 500; error: string };

export function parseTriggerSecretBody(
  body: unknown,
  allowClear: boolean,
): TriggerSecretRequest | TriggerSecretFailure {
  const record = (body ?? {}) as Record<string, unknown>;
  const secret = record.secret;
  if (secret !== undefined && (typeof secret !== "string" || secret.length === 0)) {
    return { ok: false, status: 400, error: "secret must be a non-empty string" };
  }
  const clearRaw = record.clear_secret;
  if (clearRaw !== undefined && (!allowClear || clearRaw !== true)) {
    return { ok: false, status: 400, error: "clear_secret must be true and is only allowed when editing" };
  }
  if (secret !== undefined && clearRaw === true) {
    return { ok: false, status: 400, error: "secret and clear_secret cannot be used together" };
  }
  return { ...(secret !== undefined ? { secret } : {}), clear: clearRaw === true };
}

/** Points a secret-taking event at the entry derived from the trigger id. */
export function eventWithStoreSecretRef(
  kind: TriggerFile["kind"],
  event: TriggerEvent | undefined,
  id: string,
): { ok: true; event: TriggerEvent } | TriggerSecretFailure {
  if (kind !== "event" || event === undefined || !triggerSourceTakesSecret(event.source)) {
    return {
      ok: false,
      status: 400,
      error: "secret is only allowed for webhook, github.* and email.message event triggers",
    };
  }
  return {
    ok: true,
    event: {
      ...event,
      config: { ...event.config, secretRef: `${TRIGGER_STORE_PREFIX}${triggerSecretStoreName(id)}` },
    },
  };
}

function failure(error: unknown): TriggerSecretFailure {
  if (error instanceof ChannelError && error.code === "CHANNEL_INVALID_INPUT") {
    return { ok: false, status: 400, error: "secret is not valid" };
  }
  const code = error instanceof ChannelError ? error.code : "CHANNEL_STORAGE_FAILED";
  return { ok: false, status: 500, error: `secret store failed (${code})` };
}

/**
 * Runs a trigger file change and its secret change together. A set is written first and put back
 * (restored or deleted) if the file change fails; a clear happens only after the file change
 * succeeded.
 */
export async function applyTriggerSecret<R extends { ok: boolean }>(
  secrets: SecretWriter,
  id: string,
  request: TriggerSecretRequest,
  run: () => Promise<R>,
): Promise<R | TriggerSecretFailure> {
  const name = triggerSecretStoreName(id);
  if (request.secret === undefined) {
    const result = await run();
    if (result.ok && request.clear) {
      try {
        secrets.delete(name);
      } catch (error) {
        return failure(error);
      }
    }
    return result;
  }
  let previous: string | undefined;
  try {
    previous = secrets.get(name);
    secrets.set(name, request.secret);
  } catch (error) {
    return failure(error);
  }
  const undo = () => {
    try {
      if (previous === undefined) secrets.delete(name);
      else secrets.set(name, previous);
    } catch {
      /* the original failure is the one to report */
    }
  };
  try {
    const result = await run();
    if (!result.ok) undo();
    return result;
  } catch (error) {
    undo();
    throw error;
  }
}

export function triggerSecretIsSet(trigger: TriggerFile, secrets: SecretReader): boolean {
  const ref = trigger.event?.config?.secretRef;
  const name = typeof ref === "string" ? storeNameOfRef(ref) : undefined;
  if (name === undefined) return false;
  try {
    return secrets.get(name) !== undefined;
  } catch {
    return false;
  }
}
