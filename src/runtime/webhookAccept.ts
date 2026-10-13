import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import type { TaskFile } from "../types/task.js";
import type { TriggerFile } from "../types/trigger.js";
import { matchesEventFilter } from "./triggerEventMatch.js";
import { verifyHmacSignature } from "./webhookSignature.js";

export type WebhookHeaderMap = {
  readonly [name: string]: string | string[] | undefined;
};

export type WebhookAcceptResult =
  | { kind: "not_configured" }
  | { kind: "bad_signature" }
  | {
      kind: "bad_json";
      error: "Invalid JSON body" | "Invalid JSON body: expected an object";
    }
  | { kind: "no_match" }
  | { kind: "fire"; task?: TaskFile };

export function acceptWebhook(input: {
  trigger: TriggerFile;
  rawBody: Buffer;
  headers: WebhookHeaderMap;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}): WebhookAcceptResult {
  const { trigger, rawBody, headers, env } = input;
  const now = input.now ?? Date.now;
  const config = trigger.event?.config;
  const secretRef = typeof config?.secretRef === "string" ? config.secretRef : undefined;
  const header = typeof config?.header === "string" ? config.header : undefined;
  if (secretRef === undefined || header === undefined) {
    return { kind: "not_configured" };
  }
  const scheme = config?.scheme === "base64" ? "base64" : "hex";

  let secret: string | undefined;
  try {
    secret = readSecretFromEnvOrFile(env, secretRef);
  } catch {
    secret = undefined;
  }
  if (secret === undefined) {
    return { kind: "not_configured" };
  }

  const headerValue = headers[header.toLowerCase()];
  const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (
    typeof signature !== "string" ||
    signature.length === 0 ||
    !verifyHmacSignature(rawBody, signature, secret, scheme)
  ) {
    return { kind: "bad_signature" };
  }

  let payload: unknown;
  try {
    payload = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { kind: "bad_json", error: "Invalid JSON body" };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "bad_json", error: "Invalid JSON body: expected an object" };
  }
  const payloadRecord = payload as Record<string, unknown>;

  if (!matchesEventFilter(trigger.event?.match, payloadRecord)) {
    return { kind: "no_match" };
  }

  if (trigger.task !== undefined) {
    return { kind: "fire" };
  }

  return {
    kind: "fire",
    task: {
      id: `${trigger.id}-webhook-${now()}`,
      goal: `Handle webhook event for trigger "${trigger.id}"`,
      input: payloadRecord,
    },
  };
}
